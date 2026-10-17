## Ping Pong - web port of Android mini-game from [JungleFrog.NPlayers.PingPong](https://play.google.com/store/apps/details?id=com.JindoBlu.TwoPlayerGamesChallenge&hl=en)

Original APK Reverse Engineered using [REA](https://rea.tools) + Ghidra with Sonnet 5.5 and GPT Luna 6 and rebuilt for web with Sonnet.

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

### Online multiplayer

This build is online-only. Run `npm install && npm start`, then open `http://localhost:8080` in two windows/devices to pair. First to 7 wins; Play again restarts both. Player 2's view is rotated 180°.

Netcode: server-authoritative. A shared headless `sim.js` runs the (tick-quantized Bézier) simulation on the server at 50 Hz and broadcasts snapshots (~25 Hz) plus authoritative events (`hit`, `bounce`, `point`, `win`). Clients predict their own racket and the ball, reconcile against snapshots with input replay, and interpolate the opponent's racket. Input is sequenced (`seq`/`ack`) with a jitter buffer and clock-offset correction. No peer-to-peer traffic.

Dev net simulation: `?lat=120&jit=30`. Debug overlay: `?debug=1` or press D. Expose `window.__pp` for tests.
