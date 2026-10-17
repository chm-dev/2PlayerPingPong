## Ping Pong - web port of Android mini-game from [JungleFrog.NPlayers.PingPong](https://play.google.com/store/apps/details?id=com.JindoBlu.TwoPlayerGamesChallenge&hl=en)

Original APK Reverse Engineered using [REA](https://rea.tools) with Sonnet 5.5 and GPT Luna 6 and rebuilt for web with Sonnet.

### What was reverse-engineered

* The APK is a Unity IL2CPP app (ARM, metadata v31). Extracted the type and method layout with Il2CppDumper, then decompiled the PingPong classes with Ghidra, using JDK 26
* Ball path, bounce, spin, racket hits, CPU movement, scoring and server rotation are ported from that decompiled code.
* Difficulty is also from the code: the CPU gets harder as the human pulls ahead.
* Layout, colours, sprites, camera and the hit sound come from the prefab and asset data (extracted with UnityPy).

### Not confirmed from the code

* Scoreboard and win screen: The shared UI is outside the PingPong classes.
* Hit effects: the particle burst on impact is left out.
* Trail: it is approximated.
* Ball movement formula: the exact Remap and tween easing are assumed to be a linear remap and a standard Hermite curve.

<img width="451" height="881" alt="image" src="https://github.com/user-attachments/assets/ea5dbc91-df06-4b2e-ad39-e9fc75b43ac3" />

## Online multiplayer

This build is **online-only** (no local/CPU mode). It uses a simplified, server-authoritative netcode:

- `sim.js` — shared headless simulation (ball Bézier flights, collisions, scoring, serve rotation). Runs on the server as authority and is reused by clients for racket prediction and by tests.
- `server.js` — Node + `ws` static server, lobby pairing, fixed 50 Hz sim loop, snapshots every tick, authoritative event relay.
- `game.js` — client renders interpolated ball/opponent racket, predicts the local racket with zero lag, handles p2's 180° rotated view, HUD (`?lat=&jit=` latency sim) and debug overlay.

Run: `npm install && npm start` → `http://localhost:8080` (open two windows/tabs to pair). Tests: `npm test`.
