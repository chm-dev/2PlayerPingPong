# Ping Pong — netcode plan: server-authoritative online multiplayer

Status: plan only (not implemented). Derived from the proven implementation in
`C:\dev\AI\2PlayerBasketball` (see its `AGENTS.md` and `agent/netcode-plan.md`).

Decisions locked with the user (2026-10-17):

* **Authority model: server-authoritative.** The simulation lives in a shared
  headless `sim.js`; neither browser simulates the authoritative world.
* **Online-only.** Local CPU (Easy/Medium/Hard) and local 2-player modes are
  removed, matching Basketball. No difficulty system, no CPU controller.
* **First pass = Phases 0–2** of the sibling plan: sim extraction + server
  authority, snapshot interpolation, client prediction/reconciliation.
  Reconnection, tick-stamped inputs/lag compensation and binary encoding are
  out of scope.
* **Player 2's view is rotated 180°** so their own half is at the bottom of
  their screen, with counter-rotated score text and serve hint.

---

## 1. Why the reference design fits

Basketball and Ping Pong are both two-player halves of one board with a single
shared ball. Basketball already solved:

* matchmaking and room lifecycle (`server.js`),
* a fixed-tick server authority shared with the browser via a pure `sim.js`,
* input sequencing (`seq`) + acknowledgement (`ack`) + authoritative snapshots,
* a snapshot jitter buffer with clock-offset correction,
* prediction + replay-based reconciliation with error smoothing,
* an authoritative event channel for audio/particles,
* latency simulation (`?lat=&jit=`), a net HUD and a state debug overlay.

What cannot be copied mechanically is the simulation itself: Basketball uses
ballistic physics, Ping Pong uses an eased Bézier tween with tick-based collision
sampling, swipe-derived shot parameters, a table-bounce return rule, serve
rotation and first-to-7 scoring.

## 2. Target architecture

```
   p1 client ──inputs(seq)──┐                        ┌──snapshots(tick,ack)──► p1 client
                            ▼                        ▼
                    ┌──────────────── server.js ────────────────┐
                    │  lobby: pairs every two waiting clients    │
                    │  per-room: S, input queues, ack, token     │
                    │  fixed 50 Hz accumulator → Sim.step()      │
                    │  snapshot every tick + event relay         │
                    └────────────────────────────────────────────┘
   p2 client ──inputs(seq)──┘                        └──snapshots(tick,ack)──► p2 client
```

* Roles: `p1` = Red, south half (`z < 0`, bottom of the unflipped view);
  `p2` = Blue, north half (`z > 0`), whose view is rotated 180°.
* `sim.js` is used by the server (authority), both clients (prediction/replay)
  and Node tests (golden replay). It is pure: explicit state in, events out —
  no DOM, no audio, no `Math.random`, no timing APIs.
* The client predicts the local racket **and the ball** (deliberate deviation
  from Basketball, see §6), and interpolates the opponent's racket.
* No peer-to-peer messages; the server never relays client→client traffic.

## 3. File layout

New:

| File | Purpose |
|---|---|
| `sim.js` | headless simulation (authority + prediction + tests) |
| `server.js` | static serving, lobby pairing, 50 Hz authority, snapshots, events |
| `lib/snapshot-interpolation.js` | vendored `@geckos.io/snapshot-interpolation` browser bundle (copied verbatim) |
| `lib/snapshot-interpolation.LICENSE` | attribution |
| `package.json`, `package-lock.json` | `npm start` / `npm test`, sole dependency `ws` |
| `.gitignore` | `node_modules/`, logs, editor/OS noise |
| `test/sim.test.js` | golden replay, determinism, flow rules |
| `test/server.test.js` | headless bot clients against the real server |
| `test/prediction.test.js` | client-loop bot tracking the authority |
| `test/client.boot.test.js` | DOM-stubbed boot smoke test |
| `AGENTS.md` | handoff notes for future agentic edits |

Modified:

| File | Change |
|---|---|
| `index.html` | add `#ping`/`#hud`/`#dbg`; menu becomes "2 Players - Online" + status; load `sim.js`, lib, `game.js?v=1` |
| `game.js` | rewritten as an online-only client (render/input/audio/prediction only) |
| `README.md` | keep the RE notes, add an "Online multiplayer" section |
| `assets/` | unchanged (`hit.wav`, sprites) |

No build step. Node 24 + `ws`.

## 4. `sim.js` — the shared core

### 4.1 Constants (ported unchanged)

```
FIXED = 0.02 (1/50, Unity fixedDeltaTime)
SCORE_TO_WIN = 7
RADIUS = 0.4, MOD_DIR = 8, MOD_SPIN = 0.3, MOD_POW = 7, BOUNCE = 30, ARC = 6, FLOOR = -6
T0 = 0.9
CENTER = {1:[0,-6,5], 2:[0,-6,-5]}
SERVE = {1:[0,2,-8], 2:[0,2,8]}
TABLE = {hx:6.08, hz:10.96, top:0}
SWIPE_SCALE = 0.5
EASE_M0 = 1.3626503944396973, EASE_M1 = 0.3367648124694824
```

Racket target clamp: p1 `z ∈ [-20,-5]`, p2 `z ∈ [5,20]`; x free (authority
must clamp too).

### 4.2 State `S`

```
{
  tick,
  phase: 'playing' | 'over',
  scores: [0, s1, s2],          // index 0 unused
  winner: 0|1|2,
  server: 1|2,                  // who serves next / now
  serveTicks: 0,                // countdown after a point (1 s = 50 ticks)
  flightTicks: 45,              // last hit's flight duration in ticks (tempoAnimazione)

  ball: {
    pos: [x,y,z], old: [x,y,z],
    tw: null | { tick, ticks }, // tick-quantized tween progress
    bez: null | { p0,p1,p2,p3 },// cubic; p3.x is continuously steered by spin
    hitter: 0|1|2,              // racket that last struck the ball
    last: 0|1|2,                // 2 = table/serve start; 0/1 = last racket (p2/p1)
    serving: bool,
    touching: null|'n'|'s'|'t', // collision dedupe
  },

  rackets: {
    1: { pos:[x,y,z], params:{spin,dir,pot} },
    2: { ... },
  },

  ptr: {                        // last consumed pointer state per player
    1: { x, z, held: bool },
    2: { x, z, held: bool },
  },

  events: [],                   // cleared at the start of every step()
}
```

Racket `old`/`vel` are not needed (only the CPU used `velCPU`). Trail, audio,
bursts, score overlays and camera are client-only.

### 4.3 Tick order (preserves the original update order)

1. `tick++`, clear events.
2. For each player: apply this tick's input (latest pointer target + held),
   clamp `z` to the player's half, compute the swipe from the delta between the
   consumed pointer position and this tick's position,
   `dx = Δx * (FIXED * 60) * SWIPE_SCALE` (same for dz), then
   `spin = clamp(dx,-1,1)`, `pot`/`dir` exactly as the port does;
   `u` clears `spin/dir/pot` and `held`.
3. `onKeep` equivalent for held pointers: lerp racket toward target with the
   60 Hz-equivalent factor `1 - 0.5^(60*FIXED) ≈ 0.565`; y toward `2`.
4. `racketFixed` for both rackets.
5. `ballFixed`:
   * spin steers `bez.p3[0]` while a flight exists and a hitter is recorded,
   * compute `vel` from `pos - old`, normalize to `dir`,
   * collision order: p2 racket (`'n'`) → p1 racket (`'s'`) → table (`'t'`),
     deduped by `touching`,
   * racket hit only allowed when `last === 2` (no volleys),
   * table hit only when `dir.y <= 0`; re-flight from the hit point using
     `dir`, `BOUNCE` and `FLOOR`, then set `last = 2`,
   * update `old`, `touching`.
6. Advance the tween by one tick: `tick++`, `k = min(tick/ticks, 1)`,
   `pos = bezAt(bez, ease(k))`; on completion → `pallinaCaduta`.
7. Score / serve / win flow:
   * `pallinaCaduta` decides the scorer from `last` + `hitter` exactly as the
     port does (table bounce → hitter scores; miss → opponent scores),
   * `punto`: increment, rotate `server` when `(total points) % 2 === 0`,
     set `serveTicks = 50`, or `phase = 'over'` + `winner` at 7,
   * `serveTicks` counts down each tick; at 0, `servizio()` places the ball at
     `SERVE[server]`, clears tween/trail-adjacent state, `last = 2`.
8. Emit events.

Hit flight duration: `ticks = max(1, round((T0 - 0.2*pot) / FIXED))`, stored in
`S.flightTicks` so table re-flights reuse it. `k` is sampled at integer ticks;
this replaces the original render-dt tween and makes replay exact.

### 4.4 Inputs

```
{ p, k: 'm', x, z }   // pointer is down and at world (x,z)
{ p, k: 'u' }         // pointer released
```

The client coalesces pointer moves to roughly one per animation frame (the
original applied them per frame). The sim consumes the latest target each tick,
so event frequency does not change the result. Sending absolute positions keeps
fast flicks intact across coalescing.

`applyInput` validates phase/half/clamps so server, prediction and replay share
one rule set.

### 4.5 Events (authoritative feedback only)

`{ev:'hit', p}` (racket), `{ev:'bounce'}` (table), `{ev:'point', p}`,
`{ev:'serve', p}`, `{ev:'win', p}`. Clients turn them into `hit.wav` playback;
prediction must never emit effects (prevents double audio).

### 4.6 Wire snapshot

Basketball's snapshot is position+velocity because its ball is ballistic. Here
reconciliation must be able to continue a Bézier flight and a table re-flight,
so the snapshot carries the full flight state:

```
{
  tk,                           // tick; 't' is the message type
  ph, sc:[s1,s2], w, sv, st, ta,
  b: [
    x, y, z,                    // current ball position
    ox, oy, oz,                 // previous tick position (velocity/bounce source)
    twTick, twTicks,            // 0,0 = no tween
    hitter, last, serving01, touching,  // touching: 0|1=n|2=s|3=t
    bez? 12 numbers             // p0..p3, present only while flying
  ],
  r: [[x,z,spin,dir,pot], [x,z,spin,dir,pot]]
}
```

`Sim.applySnapshot(S, s)` restores exactly the fields that `step` reads next;
`Sim.dump`/`Sim.load` serialise the same state (plus score-flow-only fields) for
the `start` message and tests. Keep send/apply index order in sync.

### 4.7 Determinism hygiene

* Replace `Math.hypot` in the ball/racket path with explicit `Math.sqrt(...)`
  (cross-engine bit differences; same rule as Basketball's test).
* No `Math.random` anywhere in the sim (CPU removed). If scoring/serve ever
  needs randomness, use a seeded LCG stored in `S`.
* No DOM, no `performance.now`, no render dt.

## 5. Protocol (JSON, whitelisted in `server.js`)

| Type | Dir | Payload |
|---|---|---|
| `join` | c→s | `{ v }` — wrong version → `{t:'ver',v}` |
| `room` | s→c | `{ role:'p1'|'p2' }` |
| `start` | s→c | `{ tm, token, S: Sim.dump() }` |
| `i` | c→s | `{ seq, k:'m'|'u', x, z, token }` |
| `s` | s→c | `{ tm, a:[ack1,ack2], ...Sim.snapshot() }` (every tick, 50 Hz) |
| `e` | s→c | `{ tick, evs:[…] }` |
| `ping`/`pong` | both | clock probe; `pong` carries server `time` |
| `again` | c→s | restart (either player, 1 s cooldown) |
| `opp_left` | s→c | partner disconnected |

Validation: integer `seq > ack` and `< ack + 10000`, finite coords within ±30,
input queue cap 64 with drop-newest backpressure, wrong token ignored, token
regenerated on every `start`. Snapshot skips on high `bufferedAmount`; events
are never skipped. Heartbeat ping every 30 s.

`PROTOCOL = 1` for this game; bump on any wire change. Bump `?v=` in
`index.html` on `game.js`/`sim.js` changes.

## 6. Client (`game.js`)

Structure mirrors Basketball: `NET`, `MY`, `P` (predicted sim state), `RB`
(rendered ball), `UI` (from snapshots), `SNAP` vault, input log, `smooth`.

### 6.1 Prediction ownership (deviation from Basketball)

* **Own racket: always predicted.** It is driven only by this client's inputs.
* **Ball: always predicted** while in a match. The flight is a deterministic
  eased Bézier; replaying ticks from the latest snapshot reproduces it exactly
  until a server-decided event (opponent hit/table bounce) changes the curve.
  Rationale: with the ball interpolated 60–100 ms behind and the local racket
  predicted ahead, the player would have to aim at where the ball *was* — not
  playable. Basketball can predict ownership-only because grabbing is a slow
  proximity action.
* **Opponent racket: interpolated** from the snapshot vault, with the local
  racket rendered from prediction.

Corrections: every snapshot → drop acked inputs, `Sim.applySnapshot(P,m)`,
replay unacked inputs from `m.tk+1` to the current tick (cap 8 inputs/tick,
same as the server), fold the pre/post difference into `smooth`, snap above
`SNAP_DIST`, decay the offset over ~70 ms (same constants as Basketball).

### 6.2 Input

* One pointer per client. `pointerdown` starts control, `pointermove` updates
  the target, `pointerup/cancel` sends `u`.
* `toWorld` derives from the same view matrix as `render()`; clamp/validate in
  the sim. No "near the ball" check is needed (the racket is the avatar).
* Coalesce sends to at most one `m` per animation frame; always send the final
  pointer position on release.
* Inputs are logged as `{ seq, k, x, z, tick, used }` and replayed on
  reconciliation. `MAX_INPUTS_PER_TICK = 8` must match the server.

### 6.3 Rendering

* Same sprites, table, trail, shadows, scores and serve hint; audio only from
  server events (`hit.wav`).
* **p2 view:** one source of truth for the view transform, used by `render()`
  and inverted by `toWorld()`:
  * p1: `ctx.setTransform(S,0,0,-S,W/2,H/2+CAM_Z*S)`
  * p2: `ctx.setTransform(-S,0,0,S,W/2,H/2-CAM_Z*S)`
  * p2 score text and "Your serve" hint are counter-rotated (`rotate(π)`).
* Score numbers come from `UI` (snapshot state); the win overlay is driven by
  `phase`/`winner` from snapshots.
* Menu: "2 Players - Online" → connect → "Waiting for opponent…" → match.
  Over: Play again (`{t:'again'}`), Menu (disconnect). `opp_left` / socket close
  → menu with a message.

### 6.4 Net HUD and diagnostics (copy Basketball)

* `#ping`: rtt, updated every 2 s.
* `#hud`: rtt / snapshot rate / jitter / corrections.
* `?lat=120&jit=30`: monotonic queues in both directions.
* `?debug=1` / D: ws state, snapshot age + STALE flag, vault size,
  PREDICT/INTERP mode, authoritative ball + tween/hitter/last/serving/touching,
  racks, smoothed render ball, pointer state; explicit dead-flight warning.
* Expose `window.__pp = { NET, MY, UI, RB, get P(){…}, Sim }` for tests.

## 7. Server details

* `Sim.FIXED` accumulator with `process.hrtime.bigint()`, check interval 3 ms.
* Every room: `S`, two input queues, `ack[2]`, `token`, `restartAt`.
* On `start`: regenerate token, `Sim.create()`, reset ack/queues, send `room`
  roles and the same `start` payload to both clients.
* Snapshot every tick (50 Hz). With the ball predicted, only the opponent's
  racket depends on interpolation; start at the vendored lib's default
  3-frame buffer (60 ms at 50 Hz) and tune with the latency simulator.
* Event relay and logging of any watchdog event.
* Graceful `start(port)` / `stop()` exports for tests; `require.main` starts.

## 8. Tests

* `sim.test.js`
  * initial state (ball at `SERVE[1]`, scores 0, tick 0)
  * deterministic golden replay of a scripted serve → hit → table bounce
  * `dump`/`load` and wire snapshot round-trip continue identically (within
    snapshot rounding)
  * serve rotation every 2 points; serve delay; ball at `SERVE[server]`
  * return rule: no racket hit while `last !== 2`
  * table bounce scores for the hitter; missed table awards the opponent
  * first to 7 → `phase 'over'`, winner
  * racket target clamped to own half; pointer-up clears swipe params
  * hygiene: no `Math.hypot`, no `Math.random` in `sim.js`
* `server.test.js`: pairing/roles, `start` + full state, input→sim→snapshot→ack,
  event relay, invalid/out-of-range/duplicate inputs, version rejection,
  disconnect → `opp_left`, restart with a new token.
* `prediction.test.js`: a bot mirroring §6.1 stays close to the authority
  through a drag + hit + flight; acked inputs are pruned.
* `client.boot.test.js`: DOM stubs, load `sim.js` + lib + `game.js`, tick two
  frames, assert `__pp` exists and the menu phase.

## 9. Rollout

| Phase | Deliverable | Result |
|---|---|---|
| 0 | `sim.js` extraction with tick-quantized flights + sim tests | one deterministic simulation used by server/tests |
| 1 | `server.js` authority + lobby + protocol + snapshot/events + server tests | headless matches work |
| 2 | client rewrite: prediction/reconciliation, interpolation, input, p2 view, HUD/debug + boot/bot tests | playable online |
| 3 | tune smoothing/interpolation with `?lat`/`?jit`, docs (`README`, `AGENTS`) | first pass complete |

## 10. Acceptance criteria

* `npm install && npm start` → open two windows/devices, pair, play a full match.
* Own racket and ball are zero-lag; opponent's racket moves smoothly.
* Hits only register after a table bounce; missed shots award the opponent;
  serve alternates every 2 points; first to 7 wins; Play again restarts both.
* p2 sees their own half at the bottom, scores upright.
* Sim is pure and deterministic; all tests pass.
* No local/CPU mode code remains.

## 11. Known limits / risks

* **Hit tick alignment.** Inputs are not tick-stamped, so the server may
  register a hit a few ticks later than the client's prediction; snapshots
  correct it (smoothed). Fixing properly requires tick-stamped inputs + lag
  compensation (later phase).
* **Marginal touches.** A predicted hit that the server rejects shows a brief
  ball correction. Standard client-prediction trade-off.
* **Opponent racket delay.** Interpolated by the buffer (≈60 ms default) while
  the ball is predicted; their racket looks slightly behind their true input.
* **Table-bounce trajectory sensitivity.** The re-flight uses `pos` + `dir`
  from the previous tick; snapshots must carry `old` and `touching` (see §4.6)
  or replay diverges.
* **Swipe semantics.** Per-tick deltas are normalized to a 60 Hz frame. Multiple
  move events inside one tick collapse to their net delta (a rapid back-and-
  forth flick loses its intermediate motion). Acceptable; validate feel with
  the latency simulator.
* **No reconnection.** A disconnect ends the match (`opp_left`), as in
  Basketball's first pass.
