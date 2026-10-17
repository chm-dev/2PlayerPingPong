# AGENTS.md — codebase notes for future agentic edits

Web port of the JungleFrog Ping Pong mini-game, server-authoritative online multiplayer.
Online-only: no local/CPU mode.

* `index.html` — overlays, `#ping`/`#hud`/`#dbg`; loads `sim.js`, `lib/snapshot-interpolation.js`, `game.js?v=1`
* `sim.js` — headless simulation (authority + client prediction + tests)
* `server.js` — Node + ws: static serving, lobby pairing, authority (50 Hz tick)
* `game.js` — client only: rendering, input, audio, interpolation, prediction, reconciliation
* `lib/snapshot-interpolation.js` — vendored BSD-3 jitter buffer
* `test/` — `node --test` suites
* `package.json` — `npm start`, `npm test`; sole dependency `ws`

Run: `npm install && npm start` → http://localhost:8080 (two windows).
Dev net sim: `?lat=120&jit=30`.

## Architecture (server-authoritative)

Roles: p1 = Red, south (z<0); p2 = Blue, north (z>0), view rotated 180°.
Server owns all state. Clients predict own racket **and the ball** (Bézier flight); opponent racket interpolated from snapshot vault.

## Protocol v1 (JSON, whitelisted by kind in server.js)

| Type | Dir | Payload |
|---|---|---|
| `join` | c→s | `{ v }` |
| `room` | s→c | `{ role:'p1'|'p2' }` |
| `start` | s→c | `{ tm, token, S }` |
| `i` | c→s | `{ seq, k:'m'|'u', x, z, token }` |
| `s` | s→c | `{ tm, a:[ack1,ack2], ...Sim.snapshot() }` (~25 Hz) |
| `e` | s→c | `{ tick, evs:[…] }` |
| `ping`/`pong` | both | clock probe |
| `again` | c→s | restart |
| `opp_left` | s→c | partner disconnected |

Snapshot `b` index order (keep send/apply in sync):
```
0 x 1 y 2 z 3 ox 4 oy 5 oz 6 twTick 7 twTicks 8 hitter 9 last 10 serving01 11 touching 12 bez(12 or null)
```

## sim.js key points

- `step(S, inputs)` runs one fixed tick (1/50): apply input batch, onKeep, racketFixed, ballFixed, advance Bézier tween, score/serve flow.
- Events: `hit{p}`, `bounce`, `point{p}`, `win{p}`. (No `serve` event.)
- Determinism: explicit `Math.sqrt`, no `Math.hypot`/`Math.random` (enforced by test).
- `flightTicks` stored in dump/load and snapshot so re-flights use correct duration.
- `ptr` not serialised; rebuilt from replayed inputs.

## Client (game.js) key points

- `shouldPredict()` is always true while playing (ball always predicted).
- Reconciliation: drop acked inputs, `Sim.applySnapshot(P,m)`, replay unacked from `m.tk+1` to current tick (cap 8), fold pre/post diff into `smooth`.
- Opponent racket interpolated from `SNAP` vault.
- p2 view: `ctx.setTransform(-S,0,0,S,W/2,H/2-CAM_Z*S)`; `toWorld` inverted (derived, not the plan's unverified formula).
- Serve hint shows only after `servicio()` (ball.serving), drawn in screen space at the bottom.

## Testing

`npm test` runs sim/server/prediction/boot tests. Keep green when touching sim, wire format, or client loop.