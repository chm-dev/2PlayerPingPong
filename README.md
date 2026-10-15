## Ping Pong - web port of Android game [JungleFrog.NPlayers.PingPong](https://play.google.com/store/apps/details?id=com.JindoBlu.TwoPlayerGamesChallenge&hl=en)

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
