# Ping Pong — netcode plan (SIMPLIFIED): server-authoritative online multiplayer

Status: plan only (not implemented). Simplified variant of `agent/netcode-plan.md`
and `agent/netcode-plan_beam.md`, trading zero-lag ball feel for ~half the
client complexity. Diverges from the Basketball reference where noted.

Decisions (inherited + new):

* **Authority model: server-authoritative.** Simulation in shared headless `sim.js`.
* **Online-only.** No local/CPU modes.
* **Simplified client (hybrid of Options 1+3+5 from the Beam review):**
  1. Client predicts **only the local racket** (zero lag). The **ball and the
     opponent's racket are linearly interpolated** between snapshots.
  2. Snapshots every tick (50 Hz) with a tiny two-point lerp — **no vendored
     jitter library**, no clock-offset correction, no `smooth` offset.
  3. Minimal wire format: ball position (+ velocity for nicer lerp) only — no
     Bézier coefficients, no `old` position, no tween state, no `serve` event.
* **Player 2's view rotated 180°.**

## 1. Why simplify

The full plan's complexity lives almost entirely in the client
prediction/reconciliation loop (input log, ack pruning, tick fast-forward of
Bézier flights, `smooth` offset, snap thresholds, jitter buffer, clock sync).
For a casual web ping-pong the ball being ~20 ms "networked" (one snapshot
interval at 50 Hz) is acceptable, and it removes the hardest correctness trap
(tick-quantizing the Bézier tween so replay matches the authority byte-for-byte).

## 2. Target architecture

```
   p1 client ──inputs(seq)──┐                        ┌──snapshots(50Hz)──► p1 client
                            ▼                        ▼
                    ┌──────────────── server.js ────────────────┐
                    │  lobby: pairs every two waiting clients    │
                    │  per-room: S, input queues, ack, token     │
                    │  fixed 50 Hz accumulator → Sim.step()     │
                    │  snapshot every tick • event relay         │
                    └────────────────────────────────────────────┘
   p2 client ──inputs(seq)──┘                        └──snapshots(50Hz)──► p2 client
```

* Roles: `p1` = Red, south (`z<0`); `p2` = Blue, north (`z>0`), view rotated 180°.
* `sim.js` used by server (authority), clients (racket prediction only) and tests.
* No peer-to-peer messages.

## 3. File layout

Same as the full plan, **minus** `lib/snapshot-interpolation.js` and its
LICENSE (no vendored dependency). `game.js` is smaller; tests drop the
prediction-bot's flight-tracking assertions.

## 4. `sim.js` — the shared core

### 4.1 Constants (ported unchanged)

```
FIXED = 0.02 (1/50)
SCORE_TO_WIN = 7
RADIUS = 0.4, MOD_DIR = 8, MOD_SPIN = 0.3, MOD_POW = 7, BOUNCE = 30, ARC = 6, FLOOR = -6
T0 = 0.9
CENTER = {1:[0,-6,5], 2:[0,-6,-5]}
SERVE = {1:[0,2,-8], 2:[0,2,8]}
TABLE = {hx:6.08, hz:10.96, top:0}
SWIPE_SCALE = 0.5
EASE_M0 = 1.3626503944396973, EASE_M1 = 0.3367648124694824
```

Racket target clamp: p1 `z ∈ [-20,-5]`, p2 `z ∈ [5,20]`; x bounded by `COORD_LIMIT`.

### 4.2 State `S`

```
{
  tick,
  phase: 'playing' | 'over',
  scores: [0, s1, s2],
  winner: 0|1|2,
  server: 1|2,
  serveTicks: 0,            // countdown after a point (50 ticks = 1 s)
  flightTicks: 45,          // last hit's flight duration in ticks

  ball: {
    pos: [x,y,z],           // current position only
    bez: null | {p0,p1,p2,p3}, // kept for the sim's own stepping (server authority)
    hitter: 0|1|2,
    last: 0|1|2,            // 2 = table/serve; 0/1 = last racket (p2/p1)
    serving: bool,
    touching: null|'n'|'s'|'t',
  },

  rackets: { 1: {pos:[x,y,z], params:{spin,dir,pot}}, 2: {...} },

  ptr: { 1: {x,z,held:bool}, 2: {x,z,held:bool} },   // no prev needed for delta?
  // NOTE: swipe delta still needs prev; keep ptr.prevX/prevZ (see 4.3).

  events: [],
}
```

`old`/`vel`/`tw` are **not** stored — the sim advances the Bézier internally
and only exposes `pos` (+ velocity derived on demand) to clients. `trail`,
`contacts` set are omitted (Ping Pong uses the single `touching` string).

### 4.3 Tick order

1. `tick++`, clear events.
2. Apply input batch (validate phase/half/clamp). For `'m'`: store target in
   `ptr[p]`, `held=true`, compute swipe delta vs. `ptr[p].prev*`, set
   `spin/pot/dir`, update `prev*`. For `'u'`: `held=false`, clear params.
3. `onKeep` for held pointers: lerp racket toward target (factor ≈0.565), y→2.
4. `racketFixed` both (no CPU branch).
5. `ballFixed`: spin steer → vel/dir from (pos − previous pos, kept in a
   local `old` recomputed each tick) → collision order p2→p1→table, deduped by
   `touching` → racket hit only if `last===2` → table hit only if `dir.y<=0`
   → re-flight → update `touching`.
6. Advance Bézier by one tick; on completion call `pallinaCaduta()`.
7. Score/serve/win flow (same as full plan: `punto`, `serveTicks` countdown,
   `servizio()` with `hitter=0`).
8. Emit events.

> Simplification: the sim still needs `old` internally to compute `vel`/`dir`
> for collisions, but it is a **local variable recomputed each tick** and never
> serialised. The wire format only carries `pos` (+ `vel` derived at snapshot
> time). This removes the "old position must survive snapshot/replay" contract
> that made the full plan fragile.

### 4.4 Inputs

```
{ p, k: 'm', x, z }   // pointer down/move
{ p, k: 'u' }         // release (no coords)
```

Validation: integer `seq > ack < ack+10000`, finite coords within ±30 only for
`'m'`, queue cap 64 drop-newest, token check.

### 4.5 Events

`{ev:'hit', p}` (racket), `{ev:'bounce'}` (table), `{ev:'point', p}`,
`{ev:'win', p}`. (No `serve` event — original plays nothing on serve.)
Prediction never emits effects; only the server's relayed events drive audio.

### 4.6 Wire snapshot (minimal)

```
{
  tk,                       // tick
  ph, sc:[s1,s2], w, sv, st, ta,
  b: [x, y, z, vx, vy, vz], // position + velocity for smooth lerp; no bez/old/tw
  r: [[x,y,z,spin,dir,pot], [x,y,z,spin,dir,pot]]
}
```

`vx/vy/vz` are derived at snapshot time (`pos - prevPos`) / FIXED. Racket
params rounded to 2 decimals. No `touching`/`hitter`/`last`/`serving` on the
wire — clients don't need them (ball is interpolated, not replayed). `serving`
is inferred client-side: `ball.pos` equals `SERVE[server]` and no flight is in
progress… actually simpler: send `sv` (server) and let the client show the serve
hint when `phase==='playing'` and the ball is stationary at the serve spot.
Or, if needed, add a single `serving: 0|1` bit. Recommend adding `serving01`
to avoid guessing.

`Sim.applySnapshot` / `dump` / `load` carry the same fields plus `phase`,
`scores`, `server`, etc. No `ptr` serialisation (rebuilt from inputs).

## 5. Protocol (JSON, whitelisted in `server.js`)

| Type | Dir | Payload |
|---|---|---|
| `join` | c→s | `{ v }` |
| `room` | s→c | `{ role:'p1'|'p2' }` |
| `start` | s→c | `{ tm, token, S: Sim.dump() }` |
| `i` | c→s | `{ seq, k:'m'|'u', x, z, token }` (`x,z` only for `'m'`) |
| `s` | s→c | `{ tm, a:[ack1,ack2], ...Sim.snapshot() }` (every tick, 50 Hz) |
| `e` | s→c | `{ tick, evs:[…] }` |
| `ping`/`pong` | both | clock probe; `pong` carries server `time` |
| `again` | c→s | restart (either player, 1 s cooldown) |
| `opp_left` | s→c | partner disconnected |

`PROTOCOL = 1`. Bump on wire change.

## 6. Client (`game.js`)

### 6.1 Prediction ownership (simplified)

* **Own racket: predicted locally.** Pointer input moves it instantly; send `'m'`.
  On snapshot, reconcile: if the server's racket pose differs by more than a
  small threshold, snap; otherwise ignore (the server applies the same inputs).
* **Ball: NOT predicted.** Interpolate position (and velocity) between the last
  two snapshots with a simple lerp over the snapshot interval.
* **Opponent racket: same interpolation** as the ball (no separate vault).

No input log, no ack replay, no `smooth` offset, no `Snap` library.

### 6.2 Input

* One pointer per client. `pointerdown` → start control + send `'m'`;
  `pointermove` → update target + send `'m'` (coalesce to ~1 per frame);
  `pointerup/cancel` → send `'u'`.
* `toWorld` from the same view matrix as `render()` (p2 inverted).

### 6.3 Rendering

* Same sprites/table/trail/shadows/scores/serve hint.
* **p2 view:** transforms as in the full plan, `toWorld` inverted and kept in sync.
* Score numbers and phase/winner from `UI` (latest snapshot).
* Serve hint after `servizio()` (ball at serve spot).
* Audio only from server events (`hit.wav` on `'hit'`/`'bounce'`).

### 6.4 Net HUD (minimal)

* `#ping`: rtt every 2 s.
* `#hud`: rtt / snapshot rate (should be ~50) / (optional) correction count.
* `?lat=120&jit=30`: optional monotonic queues for testing (can be dropped).
* `?debug=1` / D: ws state, snapshot age + STALE flag, authoritative ball/rackets,
  pointer state.

Expose `window.__pp = { NET, MY, UI, RB, Sim }` (no `P` predicted state needed,
or keep a thin `P` for the local racket).

## 7. Server details

* 50 Hz accumulator (`process.hrtime.bigint()`, 3 ms check).
* Room: `S`, two input queues, `ack[2]`, `token`, `restartAt`.
* `start`: regenerate token, `Sim.create()`, reset ack/queues, send `room` + `start`.
* **Snapshot every tick (50 Hz)** — no `SNAP_EVERY`; the higher rate is what
  makes the simple lerp smooth.
* Event relay; backpressure skip for snapshots only.
* Heartbeat 30 s; graceful `start`/`stop`.

## 8. Tests

* `sim.test.js`: initial state, deterministic replay, dump/load round-trip,
  wire snapshot round-trip (within rounding), serve rotation, scoring, first to 7,
  racket clamp, pointer-up clears params, hygiene (no `Math.hypot`/`Math.random`).
* `server.test.js`: pairing/roles, start state, input→sim→snapshot→ack, event relay,
  invalid inputs, version rejection, disconnect, restart.
* `client.boot.test.js`: DOM stubs, load `sim.js` + `game.js`, tick two frames,
  assert `__pp` exists and menu phase.

(No prediction bot — there is no prediction to validate.)

## 9. Rollout

| Phase | Deliverable | Result |
|---|---|---|
| 0 | `sim.js` extraction + sim tests | deterministic simulation |
| 1 | `server.js` authority + lobby + protocol + snapshot/events + server tests | headless matches work |
| 2 | client rewrite: racket prediction, ball/racket interpolation, input, p2 view, HUD/debug + boot test | playable online |
| 3 | tune + docs | first pass complete |

## 10. Acceptance criteria

* `npm install && npm start` → two windows pair and play a full match.
* Local racket is instant; ball and opponent racket are smooth (≤20 ms behind).
* Hits only after a table bounce; missed shots award opponent; serve alternates
  every 2 points; first to 7 wins; Play again restarts both.
* p2 sees their own half at the bottom, scores upright.
* Sim pure and deterministic; all tests pass.
* No local/CPU mode code remains.
* **No vendored snapshot library** (fewer moving parts).

## 11. Known limits / risks

* **Ball is ~20 ms behind** (one 50 Hz snapshot interval). Acceptable for casual play.
* **No input lag compensation** — already out of scope.
* **No reconnection** — disconnect ends the match.
* **Linear interpolation of a Bézier flight** slightly cuts corners on curved shots;
  at 50 Hz this is barely visible. If it bothers, raise snapshot rate or add
  velocity-based lerp (already in the format).
* **Racket reconciliation is just snap-on-threshold** — occasional 1-frame
  corrections if the server disagrees.

## 12. What this saves vs. the full plan

* No `lib/snapshot-interpolation.js` / LICENSE / boot-test eval.
* No input log, seq/ack replay, `MAX_INPUTS_PER_TICK` replay cap, `smooth` offset,
  `SNAP_DIST`, snap-vs-blend logic.
* No `bez`/`tw`/`old`/`touching`/`hitter`/`last`/`serving` on the wire (except
  a single `serving01` bit).
* No prediction bot test.
* No clock-offset correction (50 Hz + same-machine testing makes drift negligible;
  add `ping`/`pong` only if needed for the HUD rtt).

Estimated size: ~**1,200–1,500 lines** (sim ~350, server ~250, game ~400,
tests ~350) — roughly **two-thirds of the full plan**, and the client is the
part that shrinks most.