'use strict';
// sim.js — shared headless Ping Pong simulation (SIMPLIFIED netcode plan).
// Pure: explicit state in, events out. No DOM, no audio, no Math.random, no timing APIs.
(function (root) {
  const FIXED = 1 / 50;
  const SCORE_TO_WIN = 7;
  const RADIUS = 0.4;
  const MOD_DIR = 8;
  const MOD_SPIN = 0.3;
  const MOD_POW = 7;
  const BOUNCE = 30;
  const ARC = 6;
  const FLOOR = -6;
  const T0 = 0.9;
  const CENTER = { 1: [0, -6, 5], 2: [0, -6, -5] };
  const SERVE = { 1: [0, 2, -8], 2: [0, 2, 8] };
  const TABLE = { hx: 6.08, hz: 10.96, top: 0 };
  const SWIPE_SCALE = 0.5;
  const EASE_M0 = 1.3626503944396973;
  const EASE_M1 = 0.3367648124694824;
  const LERP_RACKET_FACTOR = 1 - Math.pow(0.5, 60 * FIXED); // ~0.565
  const COORD_LIMIT = 30;
  const EASE = t => {
    const t2 = t * t, t3 = t2 * t;
    return (t3 - 2 * t2 + t) * EASE_M0 + (-2 * t3 + 3 * t2) + (t3 - t2) * EASE_M1;
  };
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const remap = (v, a, b, c, d) => c + ((v - a) / (b - a)) * (d - c);
  const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const r2 = v => Math.round(v * 100) / 100;
  const sqrt = (x, y, z) => Math.sqrt(x * x + y * y + z * z);

  function makeRacket(player) {
    return { player, pos: [0, player === 1 ? 2 : 2.89, player === 1 ? -12 : 12], params: { spin: 0, dir: 0, pot: 0 } };
  }

  function create() {
    return {
      tick: 0,
      phase: 'playing',
      scores: [0, 0, 0],
      winner: 0,
      server: 1,
      serveTicks: 0,
      flightTicks: Math.round(T0 / FIXED),
      ball: {
        pos: SERVE[1].slice(),
        old: SERVE[1].slice(),
        bez: null,
        tw: null,
        hitter: 0,
        last: 2,
        serving: true,
        touching: null,
      },
      rackets: { 1: makeRacket(1), 2: makeRacket(2) },
      ptr: {
        1: { x: 0, z: -12, held: false, prevX: 0, prevZ: -12 },
        2: { x: 0, z: 12, held: false, prevX: 0, prevZ: 12 },
      },
      events: [],
    };
  }

  function sphereBox(c, r, bc, h) {
    let d2 = 0;
    for (let i = 0; i < 3; i++) {
      const d = Math.max(Math.abs(c[i] - bc[i]) - h[i], 0);
      d2 += d * d;
    }
    return d2 <= r * r;
  }
  function sphereCapsuleY(c, r, cc, rad, halfSeg) {
    const y = clamp(c[1], cc[1] - halfSeg, cc[1] + halfSeg);
    const dx = c[0] - cc[0], dy = c[1] - y, dz = c[2] - cc[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz) <= rad + r;
  }
  function applyInput(S, inp) {
    if (!inp || typeof inp.p !== 'number') return;
    const p = inp.p;
    if (p !== 1 && p !== 2) return;
    if (S.phase !== 'playing') return;
    if (inp.k === 'm') {
      const x = +inp.x, z = +inp.z;
      if (!Number.isFinite(x) || !Number.isFinite(z)) return;
      if (Math.abs(x) > COORD_LIMIT || Math.abs(z) > COORD_LIMIT) return;
      const ptr = S.ptr[p];
      const dx = (x - ptr.prevX) * (FIXED * 60) * SWIPE_SCALE;
      const dz = (z - ptr.prevZ) * (FIXED * 60) * SWIPE_SCALE;
      ptr.x = x; ptr.z = z; ptr.held = true; ptr.prevX = x; ptr.prevZ = z;
      const r = S.rackets[p];
      const tz = p === 1 ? clamp(z, -20, -5) : clamp(z, 5, 20);
      r.params.spin = clamp(dx, -1, 1);
      r.params.pot = p === 1 ? clamp(dz, -0.5, 1) : -clamp(dz, -1, 0.5);
      const m = Math.sqrt(dx * dx + dz * dz);
      r.params.dir = m <= 1e-5 ? 0 : dx / m;
    } else if (inp.k === 'u') {
      const ptr = S.ptr[p];
      ptr.held = false;
      const r = S.rackets[p];
      r.params.spin = r.params.dir = r.params.pot = 0;
    }
  }

  function onKeep(S) {
    if (S.phase !== 'playing') return;
    for (const p of [1, 2]) {
      const ptr = S.ptr[p];
      if (!ptr.held) continue;
      const r = S.rackets[p];
      const tz = p === 1 ? clamp(ptr.z, -20, -5) : clamp(ptr.z, 5, 20);
      const k = LERP_RACKET_FACTOR;
      r.pos[0] += (ptr.x - r.pos[0]) * k;
      r.pos[1] += (2 - r.pos[1]) * k;
      r.pos[2] += (tz - r.pos[2]) * k;
    }
  }

  function racketFixed(S) {
    // no CPU; nothing to do (kept for tick order / compat)
  }

  function bezAt(b, t) {
    const u = 1 - t;
    const a = u * u * u;
    const c = 3 * u * u * t;
    const d = 3 * u * t * t;
    const e = t * t * t;
    return [0, 1, 2].map(i => a * b.p0[i] + c * b.p1[i] + d * b.p2[i] + e * b.p3[i]);
  }

  function startFlight(S, p3, ticks) {
    const ball = S.ball;
    const p0 = ball.pos.slice();
    const a = [p0[0], 0, p0[2]];
    const b = [p3[0], 0, p3[2]];
    const h0 = lerp3(a, b, 0.2);
    h0[1] = ARC;
    const h1 = [p3[0], ARC, p3[2]];
    ball.bez = { p0, p1: h0, p2: h1, p3: p3.slice() };
    ball.tw = { tick: 0, ticks: Math.max(1, ticks) };
  }

  function collisione(S, tipo) {
    const ball = S.ball;
    if (tipo === 2) {
      if (ball.vel && ball.vel[1] > 0) return;
      const p3 = [ball.pos[0] + ball.dir[0] * BOUNCE, ball.pos[1] + FLOOR, ball.pos[2] + ball.dir[2] * BOUNCE];
      ball.last = 2;
      startFlight(S, p3, S.flightTicks);
      S.events.push({ ev: 'bounce' });
      return;
    }
    if (ball.last < 2) return;
    const pPlayer = tipo === 1 ? 1 : 2;
    const r = S.rackets[pPlayer];
    ball.hitter = pPlayer;
    const pr = r.params;
    const x = pr.dir * MOD_DIR * remap(pr.pot, 0, 1, 0.7, 1.0);
    const c = CENTER[pPlayer];
    const z = pPlayer === 1 ? c[2] + pr.pot * MOD_POW : c[2] - pr.pot * MOD_POW;
    const tempoAnimazione = T0 + pr.pot * -0.2;
    S.flightTicks = Math.max(1, Math.round(tempoAnimazione / FIXED));
    ball.last = tipo === 1 ? 1 : 0;
    ball.serving = false;
    startFlight(S, [x, c[1], z], S.flightTicks);
    S.events.push({ ev: 'hit', p: pPlayer });
  }

  function ballFixed(S) {
    const ball = S.ball;
    if (ball.bez && ball.hitter) {
      const hr = S.rackets[ball.hitter];
      if (hr) ball.bez.p3[0] += hr.params.spin * MOD_SPIN;
    }
    const p = ball.pos;
    // vel from old
    const vel = [p[0] - ball.old[0], p[1] - ball.old[1], p[2] - ball.old[2]];
    ball.vel = vel;
    const m = Math.sqrt(vel[0] * vel[0] + vel[1] * vel[1] + vel[2] * vel[2]);
    const dir = m <= 1e-5 ? [0, 0, 0] : [vel[0] / m, vel[1] / m, vel[2] / m];
    ball.dir = dir;

    // capZ
    function capZ(player) { return player === 1 ? 0.66 : -0.66; }
    function overlapRacket(r, pt, player) {
      const cz = capZ(player);
      if (sphereBox(pt, RADIUS, r.pos, [2, 5, 2.25])) return true;
      const cc = [r.pos[0], r.pos[1], r.pos[2] + cz];
      const rad = 1.67, halfSeg = (10 - 2 * 1.67) / 2;
      const y = clamp(pt[1], cc[1] - halfSeg, cc[1] + halfSeg);
      const dx = pt[0] - cc[0], dy = pt[1] - y, dz = pt[2] - cc[2];
      return Math.sqrt(dx * dx + dy * dy + dz * dz) <= rad + RADIUS;
    }
    function overlapTable(pt) {
      return sphereBox(pt, RADIUS, [0, -0.6, 0], [TABLE.hx, 0.6, TABLE.hz]);
    }

    let hit = null;
    if (overlapRacket(S.rackets[2], p, 2)) hit = 'n';
    else if (overlapRacket(S.rackets[1], p, 1)) hit = 's';
    else if (overlapTable(p)) hit = 't';
    if (hit && hit !== ball.touching) {
      collisione(S, hit === 'n' ? 0 : hit === 's' ? 1 : 2);
    }
    ball.touching = hit;
    ball.old = ball.pos.slice();
  }

  function pallinaCaduta(S) {
    const ball = S.ball;
    let scorer = 0;
    const nord = ball.hitter === 2;
    const sud = ball.hitter === 1;
    if (ball.last === 2) {
      if (nord) scorer = 2;
      else if (sud) scorer = 1;
    } else {
      if (nord) scorer = 1;
      else if (sud) scorer = 2;
    }
    if (scorer) punto(S, scorer);
  }

  function punto(S, player) {
    S.scores[player]++;
    if (S.scores[1] < SCORE_TO_WIN && S.scores[2] < SCORE_TO_WIN) {
      if ((S.scores[1] + S.scores[2]) % 2 === 0) S.server = S.server === 1 ? 2 : 1;
      S.serveTicks = 50;
    } else {
      S.phase = 'over';
      S.winner = player;
      S.events.push({ ev: 'win', p: player });
    }
    S.events.push({ ev: 'point', p: player });
  }

  function servizio(S) {
    const ball = S.ball;
    ball.serving = true;
    ball.tw = null;
    ball.bez = null;
    ball.last = 2;
    ball.pos = SERVE[S.server].slice();
    ball.old = ball.pos.slice();
    ball.touching = null;
    ball.hitter = 0;
  }

  function step(S, inputs) {
    S.tick++;
    S.events.length = 0;
    if (inputs) {
      for (let i = 0; i < inputs.length; i++) {
        const inp = inputs[i];
        if (inp && typeof inp === 'object') {
          applyInput(S, { p: inp.p, k: inp.k, x: inp.x, z: inp.z });
        }
      }
    }
    onKeep(S);
    racketFixed(S);
    ballFixed(S);
    // advance tween
    const tw = S.ball.tw;
    if (tw) {
      tw.tick++;
      const k = Math.min(tw.tick / tw.ticks, 1);
      if (S.ball.bez) S.ball.pos = bezAt(S.ball.bez, EASE(k));
      if (k >= 1) {
        S.ball.tw = null;
        pallinaCaduta(S);
      }
    }
    // score/serve flow
    if (S.phase === 'playing' && S.serveTicks > 0) {
      S.serveTicks--;
      if (S.serveTicks === 0) servizio(S);
    }
    return S.events;
  }

  // wire snapshot (minimal) + serving bit
  function snapshot(S) {
    const ball = S.ball;
    const bez = (ball.tw && ball.bez) ? [
      r2(ball.bez.p0[0]), r2(ball.bez.p0[1]), r2(ball.bez.p0[2]),
      r2(ball.bez.p1[0]), r2(ball.bez.p1[1]), r2(ball.bez.p1[2]),
      r2(ball.bez.p2[0]), r2(ball.bez.p2[1]), r2(ball.bez.p2[2]),
      r2(ball.bez.p3[0]), r2(ball.bez.p3[1]), r2(ball.bez.p3[2]),
    ] : null;
    return {
      tk: S.tick,
      ph: S.phase,
      sc: [S.scores[1], S.scores[2]],
      w: S.winner,
      sv: S.server,
      st: S.serveTicks,
      ta: S.flightTicks,
      se: ball.serving ? 1 : 0,
      serving: ball.serving ? 1 : 0,
      serving01: ball.serving ? 1 : 0,
      b: [
        r2(ball.pos[0]), r2(ball.pos[1]), r2(ball.pos[2]),
        r2(ball.old[0]), r2(ball.old[1]), r2(ball.old[2]),
        ball.tw ? ball.tw.tick : 0,
        ball.tw ? ball.tw.ticks : 0,
        ball.hitter,
        ball.last,
        ball.serving ? 1 : 0,
        touchingCode(ball.touching),
        bez,
      ],
      r: [
        [r2(S.rackets[1].pos[0]), r2(S.rackets[1].pos[1]), r2(S.rackets[1].pos[2]), r2(S.rackets[1].params.spin), r2(S.rackets[1].params.dir), r2(S.rackets[1].params.pot)],
        [r2(S.rackets[2].pos[0]), r2(S.rackets[2].pos[1]), r2(S.rackets[2].pos[2]), r2(S.rackets[2].params.spin), r2(S.rackets[2].params.dir), r2(S.rackets[2].params.pot)],
      ],
    };
  }

  function touchingCode(t) { return t === 'n' ? 1 : t === 's' ? 2 : t === 't' ? 3 : 0; }
  function touchingFromCode(c) { return c === 1 ? 'n' : c === 2 ? 's' : c === 3 ? 't' : null; }

  function applySnapshot(S, s) {
    if (!s) return S;
    S.tick = s.tk != null ? s.tk : S.tick;
    S.phase = s.ph != null ? s.ph : S.phase;
    if (s.sc) { S.scores[1] = s.sc[0]; S.scores[2] = s.sc[1]; }
    S.winner = s.w != null ? s.w : S.winner;
    S.server = s.sv != null ? s.sv : S.server;
    S.serveTicks = s.st != null ? s.st : S.serveTicks;
    S.flightTicks = s.ta != null ? s.ta : S.flightTicks;
    const ball = S.ball;
    const b = s.b || [];
    ball.pos = [b[0] != null ? b[0] : ball.pos[0], b[1] != null ? b[1] : ball.pos[1], b[2] != null ? b[2] : ball.pos[2]];
    ball.old = [b[3] != null ? b[3] : ball.old[0], b[4] != null ? b[4] : ball.old[1], b[5] != null ? b[5] : ball.old[2]];
    const twTick = b[6] != null ? b[6] : 0;
    const twTicks = b[7] != null ? b[7] : 0;
    ball.tw = (twTicks > 0) ? { tick: twTick, ticks: twTicks } : null;
    ball.hitter = b[8] != null ? b[8] : 0;
    ball.last = b[9] != null ? b[9] : 2;
    const se = (b[10] != null ? b[10] : (s.se != null ? s.se : (s.serving != null ? s.serving : (s.serving01 != null ? s.serving01 : 0))));
    ball.serving = !!se;
    ball.touching = touchingFromCode(b[11] != null ? b[11] : 0);
    const bezArr = b[12];
    if (bezArr && Array.isArray(bezArr) && bezArr.length === 12) {
      ball.bez = {
        p0: [bezArr[0], bezArr[1], bezArr[2]],
        p1: [bezArr[3], bezArr[4], bezArr[5]],
        p2: [bezArr[6], bezArr[7], bezArr[8]],
        p3: [bezArr[9], bezArr[10], bezArr[11]],
      };
    } else {
      ball.bez = null;
      if (!ball.tw) { /* no flight */ }
    }
    if (!ball.tw) ball.bez = null;
    if (s.r && s.r[0]) {
      const r0 = s.r[0], r1 = s.r[1];
      S.rackets[1].pos = [r0[0], r0[1], r0[2]];
      S.rackets[1].params = { spin: r0[3], dir: r0[4], pot: r0[5] };
      S.rackets[2].pos = [r1[0], r1[1], r1[2]];
      S.rackets[2].params = { spin: r1[3], dir: r1[4], pot: r1[5] };
    }
    S.events.length = 0;
    return S;
  }

  function dump(S) {
    const ball = S.ball;
    return {
      tick: S.tick,
      ph: S.phase,
      sc: [S.scores[1], S.scores[2]],
      w: S.winner,
      sv: S.server,
      st: S.serveTicks,
      ta: S.flightTicks,
      se: ball.serving ? 1 : 0,
      serving: ball.serving ? 1 : 0,
      serving01: ball.serving ? 1 : 0,
      b: [r2(ball.pos[0]), r2(ball.pos[1]), r2(ball.pos[2]), r2((ball.pos[0] - ball.old[0]) / FIXED), r2((ball.pos[1] - ball.old[1]) / FIXED), r2((ball.pos[2] - ball.old[2]) / FIXED)],
      r: [
        [r2(S.rackets[1].pos[0]), r2(S.rackets[1].pos[1]), r2(S.rackets[1].pos[2]), r2(S.rackets[1].params.spin), r2(S.rackets[1].params.dir), r2(S.rackets[1].params.pot)],
        [r2(S.rackets[2].pos[0]), r2(S.rackets[2].pos[1]), r2(S.rackets[2].pos[2]), r2(S.rackets[2].params.spin), r2(S.rackets[2].params.dir), r2(S.rackets[2].params.pot)],
      ],
      // full-state extras for exact replay
      _full: {
        ball: {
          pos: ball.pos.slice(),
          old: ball.old.slice(),
          bez: ball.bez ? { p0: ball.bez.p0.slice(), p1: ball.bez.p1.slice(), p2: ball.bez.p2.slice(), p3: ball.bez.p3.slice() } : null,
          tw: ball.tw ? { tick: ball.tw.tick, ticks: ball.tw.ticks } : null,
          hitter: ball.hitter,
          last: ball.last,
          serving: ball.serving,
          touching: touchingCode(ball.touching),
        },
        scores: S.scores.slice(),
        server: S.server,
        serveTicks: S.serveTicks,
        flightTicks: S.flightTicks,
        phase: S.phase,
        winner: S.winner,
        tick: S.tick,
        rackets: {
          1: { pos: S.rackets[1].pos.slice(), params: { spin: S.rackets[1].params.spin, dir: S.rackets[1].params.dir, pot: S.rackets[1].params.pot } },
          2: { pos: S.rackets[2].pos.slice(), params: { spin: S.rackets[2].params.spin, dir: S.rackets[2].params.dir, pot: S.rackets[2].params.pot } },
        },
        ptr: {
          1: { x: S.ptr[1].x, z: S.ptr[1].z, held: S.ptr[1].held, prevX: S.ptr[1].prevX, prevZ: S.ptr[1].prevZ },
          2: { x: S.ptr[2].x, z: S.ptr[2].z, held: S.ptr[2].held, prevX: S.ptr[2].prevX, prevZ: S.ptr[2].prevZ },
        },
      },
    };
  }

  function load(o) {
    const S = create();
    if (!o) return S;
    // Prefer full state if present
    const f = o._full;
    if (f) {
      S.tick = f.tick;
      S.phase = f.phase;
      S.scores = f.scores.slice();
      S.winner = f.winner;
      S.server = f.server;
      S.serveTicks = f.serveTicks;
      S.flightTicks = f.flightTicks;
      const ball = S.ball;
      ball.pos = f.ball.pos.slice();
      ball.old = f.ball.old.slice();
      ball.bez = f.ball.bez ? { p0: f.ball.bez.p0.slice(), p1: f.ball.bez.p1.slice(), p2: f.ball.bez.p2.slice(), p3: f.ball.bez.p3.slice() } : null;
      ball.tw = f.ball.tw ? { tick: f.ball.tw.tick, ticks: f.ball.tw.ticks } : null;
      ball.hitter = f.ball.hitter;
      ball.last = f.ball.last;
      ball.serving = f.ball.serving;
      ball.touching = touchingFromCode(f.ball.touching);
      S.rackets[1].pos = f.rackets[1].pos.slice();
      S.rackets[1].params = { spin: f.rackets[1].params.spin, dir: f.rackets[1].params.dir, pot: f.rackets[1].params.pot };
      S.rackets[2].pos = f.rackets[2].pos.slice();
      S.rackets[2].params = { spin: f.rackets[2].params.spin, dir: f.rackets[2].params.dir, pot: f.rackets[2].params.pot };
      S.ptr[1] = { x: f.ptr[1].x, z: f.ptr[1].z, held: f.ptr[1].held, prevX: f.ptr[1].prevX, prevZ: f.ptr[1].prevZ };
      S.ptr[2] = { x: f.ptr[2].x, z: f.ptr[2].z, held: f.ptr[2].held, prevX: f.ptr[2].prevX, prevZ: f.ptr[2].prevZ };
      return S;
    }
    // Fallback: treat like wire snapshot
    applySnapshot(S, o);
    return S;
  }

  const Sim = {
    FIXED, SCORE_TO_WIN, RADIUS, MOD_DIR, MOD_SPIN, MOD_POW, BOUNCE, ARC, FLOOR, T0,
    CENTER, SERVE, TABLE, SWIPE_SCALE, EASE_M0, EASE_M1, COORD_LIMIT,
    create, step, snapshot, applySnapshot, dump, load,
    // helpers exposed for tests
    ease: EASE,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Sim;
  else root.Sim = Sim;
})(typeof globalThis !== 'undefined' ? globalThis : this);
