'use strict';
const Sim = window.Sim;
const $ = id => document.getElementById(id);
const canvas = $('c'),
  ctx = canvas.getContext('2d');

// ---- constants ----
const FIXED = 1 / 50;
const CAM_SIZE = 20,
  CAM_Z = -0.04;
const BG = '#FBCF6E';
const SCORE_TO_WIN = 7;
const RADIUS = 0.4,
  MOD_DIR = 8,
  MOD_SPIN = 0.3,
  MOD_POW = 7,
  BOUNCE = 30,
  ARC = 6,
  FLOOR = -6,
  T0 = 0.9;
const CENTER = { 1: [0, -6, 5], 2: [0, -6, -5] };
const SERVE = { 1: [0, 2, -8], 2: [0, 2, 8] };
const TABLE = { hx: 6.08, hz: 10.96, top: 0 };
const IMG_PPU_BALL = 12.4;
const LERP_RACKET = 0.5;
const SWIPE_SCALE = 0.5;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rand = (a, b) => a + Math.random() * (b - a);
const remap = (v, a, b, c, d) => c + ((v - a) / (b - a)) * (d - c);
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const lerp = (a, b, t) => a + (b - a) * t;

const IMGS = {};
const imgList = {
  racket: 'Racchetta_4848.png',
  ring: 'Cerchio_128_Bucato_4663.png',
  disc: 'Cerchio_128_4781.png',
  shadowBig: 'Cerchio_1024_22.png',
  border: 'Bordo_4303.png',
};
let audioCtx = null,
  hitBuf = null;
function loadAll() {
  const ps = Object.entries(imgList).map(
    ([k, f]) =>
      new Promise(res => {
        const i = new Image();
        i.onload = () => {
          IMGS[k] = i;
          res();
        };
        i.src = 'assets/' + f;
      }),
  );
  return Promise.all(ps);
}
function initAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    fetch('assets/hit.wav')
      .then(r => r.arrayBuffer())
      .then(b => audioCtx.decodeAudioData(b))
      .then(b => {
        hitBuf = b;
      })
      .catch(() => {});
  } catch (e) {
    audioCtx = null;
  }
}
function playHit() {
  if (!audioCtx || !hitBuf) return;
  const s = audioCtx.createBufferSource();
  s.buffer = hitBuf;
  s.playbackRate.value = rand(0.9, 1.1);
  s.connect(audioCtx.destination);
  s.start();
}

// ---- net state ----
const QS = new URLSearchParams(location.search);
const DEV_LAT = Math.max(0, +QS.get('lat') || 0);
const DEV_JIT = Math.max(0, +QS.get('jit') || 0);

const NET = { ws: null, connecting: false, pingTimer: null, rtt: 0, offset: null,
  snapLast: 0, snapCount: 0, snapRate: 0, corrections: 0 };
const MY = { role: 0, seq: 0, token: null };
const outQ = [], inQ = [];
let outAt = 0, inAt = 0;
function rawSend(m) { if (NET.ws && NET.ws.readyState === 1) NET.ws.send(JSON.stringify(m)); }
function netSend(m) {
  if (!DEV_LAT && !DEV_JIT) return rawSend(m);
  const now = performance.now();
  outAt = Math.max(outAt + 0.5, now + Math.max(0, DEV_LAT + (DEV_JIT ? rand(-DEV_JIT, DEV_JIT) : 0)));
  outQ.push({ at: outAt, m });
}
function flushDevQueues() {
  if (!DEV_LAT && !DEV_JIT) return;
  const now = performance.now();
  while (outQ.length && outQ[0].at <= now) rawSend(outQ.shift().m);
  while (inQ.length && inQ[0].at <= now) {
    const p = inQ.shift();
    try { netMessage(JSON.parse(p.s)); } catch (e) { /* ignore */ }
  }
}

function netConnect() {
  NET.connecting = true;
  let url;
  if (location.protocol.startsWith('http'))
    url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  else url = 'ws://localhost:8080';
  try { NET.ws = new WebSocket(url); } catch (e) { netFail('Connection failed'); return; }
  NET.ws.onopen = () => { rawSend({ t: 'join', v: 1 }); $('netStatus').textContent = 'Waiting for opponent…'; };
  NET.ws.onmessage = e => {
    if (DEV_LAT || DEV_JIT) {
      const now = performance.now();
      inAt = Math.max(inAt + 0.5, now + Math.max(0, DEV_LAT + (DEV_JIT ? rand(-DEV_JIT, DEV_JIT) : 0)));
      inQ.push({ at: inAt, s: e.data });
    } else {
      try { netMessage(JSON.parse(e.data)); } catch (err) { /* ignore */ }
    }
  };
  NET.ws.onclose = netClosed;
  NET.ws.onerror = () => { /* onclose follows */ };
}
function netFail(msg) {
  NET.connecting = false;
  $('netStatus').textContent = msg;
}
function netClosed() {
  NET.ws = null;
  if (MY.role) return netToMenu('Connection lost');
  if (NET.connecting) netFail('Connection failed');
}
function netToMenu(msg) {
  MY.role = 0; MY.token = null; MY.seq = 0;
  UI.phase = 'menu';
  phase = 'menu';
  if (NET.ws) { const ws = NET.ws; NET.ws = null; try { ws.close(); } catch (e) { /* ignore */ } }
  clearInterval(NET.pingTimer); NET.pingTimer = null;
  outQ.length = 0; inQ.length = 0;
  snapPrev = null; snapCurr = null;
  $('hud').style.display = 'none'; $('ping').style.display = 'none';
  $('over').classList.add('hidden'); $('menu').classList.remove('hidden');
  $('netStatus').textContent = msg;
}
function netMessage(m) {
  switch (m.t) {
    case 'room': NET.connecting = false; MY.role = m.role === 'p1' ? 1 : 2; break;
    case 'start': startMatch(m); break;
    case 's': if (UI.phase !== 'menu') onSnapshot(m); break;
    case 'e': if (UI.phase !== 'menu') onEvents(m); break;
    case 'ping': rawSend({ t: 'pong', ts: m.ts, time: Date.now() }); break;
    case 'pong': {
      NET.rtt = Math.max(0, Math.round(performance.now() - m.ts));
      const el = $('ping');
      el.style.display = 'block'; el.textContent = NET.rtt + ' ms';
      break;
    }
    case 'opp_left': netToMenu('Opponent left'); break;
    case 'ver': netFail('Please refresh — the server was updated'); break;
  }
}
function pingServer() { netSend({ t: 'ping', ts: performance.now() }); }

// ---- game state ----
let phase = 'menu';
const rackets = { 1: makeRacket(1), 2: makeRacket(2) };
function makeRacket(player) {
  return { player, pos: [0, player === 1 ? 2 : 2.89, player === 1 ? -12 : 12], params: { spin: 0, dir: 0, pot: 0 } };
}
const RB = { pos: [0, 2, -8] }; // render ball
const UI = { phase: 'menu', scores: [0, 0, 0], winner: 0, server: 1, serveTicks: 0, serving: false, flightTicks: 45 };

let snapPrev = null, snapCurr = null;

function startMatch(m) {
  MY.token = m.token;
  const s = m.S;
  UI.phase = s.ph || 'playing';
  UI.scores = s.sc ? s.sc.slice() : [0, 0];
  UI.winner = s.w || 0;
  UI.server = s.sv || 1;
  UI.serveTicks = s.st || 0;
  UI.serving = !!s.se;
  UI.flightTicks = s.ta || 45;
  rackets[1].pos = s.r ? s.r[0].slice(0, 3) : [0, 2, -12];
  rackets[1].params = { spin: s.r ? s.r[0][3] : 0, dir: s.r ? s.r[0][4] : 0, pot: s.r ? s.r[0][5] : 0 };
  rackets[2].pos = s.r ? s.r[1].slice(0, 3) : [0, 2.89, 12];
  rackets[2].params = { spin: s.r ? s.r[1][3] : 0, dir: s.r ? s.r[1][4] : 0, pot: s.r ? s.r[1][5] : 0 };
  RB.pos = s.b ? s.b.slice(0, 3) : (SERVE[UI.server] || [0, 2, -8]).slice();
  snapPrev = null; snapCurr = null;
  phase = 'playing';
  $('menu').classList.add('hidden');
  $('over').classList.add('hidden');
  $('hud').style.display = 'block';
  clearInterval(NET.pingTimer);
  NET.pingTimer = setInterval(pingServer, 2000);
  pingServer();
}

function onSnapshot(m) {
  // store snapshots for interpolation
  const now = performance.now();
  if (!snapCurr) {
    snapPrev = { t: now, m };
    snapCurr = { t: now, m };
  } else {
    snapPrev = snapCurr;
    snapCurr = { t: now, m };
  }
  // UI state
  if (m.sc) { UI.scores = m.sc.slice(); }
  UI.phase = m.ph || UI.phase;
  UI.winner = m.w != null ? m.w : UI.winner;
  UI.server = m.sv != null ? m.sv : UI.server;
  UI.serveTicks = m.st != null ? m.st : UI.serveTicks;
  UI.serving = !!(m.se != null ? m.se : (m.serving != null ? m.serving : m.serving01));
  UI.flightTicks = m.ta != null ? m.ta : UI.flightTicks;
  phase = UI.phase;

  // reconcile local racket
  const role = MY.role;
  if (role) {
    const serverRacket = m.r && m.r[role - 1];
    if (serverRacket) {
      const rr = rackets[role];
      const dx = rr.pos[0] - serverRacket[0];
      const dy = rr.pos[1] - serverRacket[1];
      const dz = rr.pos[2] - serverRacket[2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > 0.75) {
        rr.pos = [serverRacket[0], serverRacket[1], serverRacket[2]];
        rr.params = { spin: serverRacket[3], dir: serverRacket[4], pot: serverRacket[5] };
        NET.corrections++;
      }
    }
  }

  // handle phase over
  if (UI.phase === 'over') {
    const w = UI.winner;
    $('overTitle').textContent = w === 1 ? 'Red wins!' : (w === 2 ? 'Blue wins!' : 'Game over');
    $('over').classList.remove('hidden');
  } else {
    $('over').classList.add('hidden');
  }
  NET.snapCount++;
  NET.snapLast = now;
}

function onEvents(m) {
  for (let i = 0; i < (m.evs || []).length; i++) {
    const ev = m.evs[i];
    if (ev.ev === 'hit' || ev.ev === 'bounce') playHit();
  }
}

// ---- view ----
let W = 0, H = 0, S = 1, halfW = 11.25;
function resize() {
  const vw = innerWidth, vh = innerHeight;
  const w = Math.min(vw, Math.round((vh * 9) / 16)), h = vh;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const st = $('stage');
  st.style.width = w + 'px';
  st.style.height = h + 'px';
  W = canvas.width; H = canvas.height;
  S = H / (CAM_SIZE * 2);
  halfW = (W / H) * CAM_SIZE;
}
addEventListener('resize', resize);

function toWorld(e) {
  const r = canvas.getBoundingClientRect();
  const sx = ((e.clientX - r.left) / r.width) * W;
  const sy = ((e.clientY - r.top) / r.height) * H;
  let wx, wz;
  if (MY.role === 2) {
    wx = (W / 2 - sx) / S;
    wz = (sy - H / 2 + CAM_Z * S) / S;
  } else {
    wx = (sx - W / 2) / S;
    wz = (H / 2 - sy) / S + CAM_Z;
  }
  // bound to viewport
  wx = clamp(wx, -halfW, halfW);
  wz = clamp(wz, -CAM_SIZE, CAM_SIZE);
  return [wx, wz];
}

// ---- input ----
const touches = new Map();
canvas.addEventListener('pointerdown', e => {
  initAudio();
  if (phase !== 'playing') return;
  const [x, z] = toWorld(e);
  const role = MY.role;
  if (!role) return;
  canvas.setPointerCapture(e.pointerId);
  touches.set(e.pointerId, { player: role, pos: [x, z], prev: [x, z] });
  netSend({ t: 'i', seq: ++MY.seq, k: 'm', x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100, token: MY.token });
  e.preventDefault();
});
canvas.addEventListener('pointermove', e => {
  const t = touches.get(e.pointerId);
  if (!t) return;
  const [x, z] = toWorld(e);
  t.pos = [x, z];
  // coalesce: send every move
  netSend({ t: 'i', seq: ++MY.seq, k: 'm', x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100, token: MY.token });
});
const endTouch = e => {
  const t = touches.get(e.pointerId);
  if (t) {
    touches.delete(e.pointerId);
    netSend({ t: 'i', seq: ++MY.seq, k: 'u', token: MY.token });
  }
};
canvas.addEventListener('pointerup', endTouch);
canvas.addEventListener('pointercancel', endTouch);

function onKeep(t, frameScale) {
  const r = rackets[t.player];
  if (phase !== 'playing') return;
  const dx = (t.pos[0] - t.prev[0]) * frameScale * SWIPE_SCALE;
  const dz = (t.pos[1] - t.prev[1]) * frameScale * SWIPE_SCALE;
  t.prev = t.pos.slice();
  let tz = t.pos[1];
  tz = t.player === 1 ? clamp(tz, -20, -5) : clamp(tz, 5, 20);
  const k = clamp(LERP_RACKET, 0, 1);
  // use 0.565? plan says 0.565; use LERP_RACKET (0.5) original. But server uses 0.565. Mismatch minor; reconcile. Could use 0.565:
  const kk = 1 - Math.pow(0.5, 60 * FIXED);
  r.pos[0] += (t.pos[0] - r.pos[0]) * kk;
  r.pos[1] += (2 - r.pos[1]) * kk;
  r.pos[2] += (tz - r.pos[2]) * kk;
  r.params.spin = clamp(dx, -1, 1);
  r.params.pot = t.player === 1 ? clamp(dz, -0.5, 1) : -clamp(dz, -1, 0.5);
  const m = Math.sqrt(dx * dx + dz * dz);
  r.params.dir = m <= 1e-5 ? 0 : dx / m;
}

// ---- rendering helpers (original) ----
const tintCache = new Map();
function tinted(img, color) {
  const key = img.src + color;
  let c = tintCache.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = img.width || 1;
  c.height = img.height || 1;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  g.globalCompositeOperation = 'multiply';
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(img, 0, 0);
  tintCache.set(key, c);
  return c;
}
function sprite(img, x, z, w, h, opt = {}) {
  ctx.save();
  ctx.translate(x, z);
  ctx.scale(1, -1);
  if (opt.rot) ctx.rotate(opt.rot);
  ctx.globalAlpha = opt.alpha == null ? 1 : opt.alpha;
  ctx.drawImage(opt.tint ? tinted(img, opt.tint) : img, -w / 2, -h / 2, w, h);
  ctx.restore();
}
function slice9(img, x, z, w, h, b, srcB, color) {
  const src = tinted(img, color),
    iw = img.width || 1,
    ih = img.height || 1;
  const xs = [0, srcB, iw - srcB, iw],
    ys = [0, srcB, ih - srcB, ih];
  const xd = [-w / 2, -w / 2 + b, w / 2 - b, w / 2],
    yd = [-h / 2, -h / 2 + b, h / 2 - b, h / 2];
  ctx.save();
  ctx.translate(x, z);
  ctx.scale(1, -1);
  for (let j = 0; j < 3; j++)
    for (let i = 0; i < 3; i++)
      ctx.drawImage(
        src,
        xs[i],
        ys[j],
        xs[i + 1] - xs[i],
        ys[j + 1] - ys[j],
        xd[i],
        yd[j],
        xd[i + 1] - xd[i],
        yd[j + 1] - yd[j],
      );
  ctx.restore();
}
function rect(x, z, w, h, color, alpha = 1) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fillRect(x - w / 2, z - h / 2, w, h);
  ctx.globalAlpha = 1;
}
function ballScale(y) {
  if (y >= 5) return 1.4;
  if (y > 1) return 1 + ((y - 1) / 4) * 0.4;
  if (y >= -1) return 1;
  if (y > -5) return 1 - ((-1 - y) / 4) * 0.3;
  return 0.7;
}

// ---- interpolation ----
function interpSnapshots(now) {
  if (!snapCurr) return;
  if (!snapPrev) snapPrev = snapCurr;
  let alpha = 1;
  const dt = snapCurr.t - snapPrev.t;
  if (dt > 0) alpha = clamp((now - snapPrev.t) / dt, 0, 1);
  const b0 = snapPrev.m.b, b1 = snapCurr.m.b;
  if (b0 && b1) {
    RB.pos = [lerp(b0[0], b1[0], alpha), lerp(b0[1], b1[1], alpha), lerp(b0[2], b1[2], alpha)];
  }
  // opponent racket
  const role = MY.role;
  if (role) {
    const opp = role === 1 ? 2 : 1;
    const r0 = snapPrev.m.r && snapPrev.m.r[opp - 1];
    const r1 = snapCurr.m.r && snapCurr.m.r[opp - 1];
    if (r0 && r1) {
      rackets[opp].pos = [lerp(r0[0], r1[0], alpha), lerp(r0[1], r1[1], alpha), lerp(r0[2], r1[2], alpha)];
      rackets[opp].params = { spin: r1[3], dir: r1[4], pot: r1[5] };
    }
  }
}

// ---- rendering ----
function render(now) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  const flip = MY.role === 2;
  if (flip) ctx.setTransform(-S, 0, 0, S, W / 2, H / 2 - CAM_Z * S);
  else ctx.setTransform(S, 0, 0, -S, W / 2, H / 2 + CAM_Z * S);

  const bp = RB.pos;
  const by = bp[1];
  const bs = ballScale(by);
  const below = by < 0;
  const drawBall = () => {
    sprite(IMGS.ring, bp[0], bp[2], 10.32 * 0.18 * bs, 10.32 * 0.18 * bs, { tint: '#000' });
    sprite(IMGS.disc, bp[0], bp[2], 10.32 * 0.1 * bs, 10.32 * 0.1 * bs);
  };
  const drawTable = () => {
    slice9(IMGS.border, 0, 0, 8.18 * 1.5, 14.7 * 1.5, 0.5 * 1.5, 50, '#000');
    rect(0, 0, 10.968911, 20.755992, '#76CA3E');
    rect(0, 0, 0.64, 20.756, '#fff');
    rect(0, 0, 10.9888, 0.8048, '#000');
    rect(0, 0, 10.9888, 0.1989, '#fff');
  };

  sprite(IMGS.shadowBig, bp[0] + 0.3, bp[2], 10.24 * 0.12, 10.24 * 0.12, { alpha: 0.2, tint: '#000' });
  if (below) drawBall();
  drawTable();
  // trail skipped
  for (const p of [1, 2]) {
    const r = rackets[p];
    sprite(IMGS.racket, r.pos[0] + 0.5, r.pos[2], (IMGS.racket && IMGS.racket.width ? IMGS.racket.width : 414) / 100, (IMGS.racket && IMGS.racket.height ? IMGS.racket.height : 542) / 100, { rot: p === 2 ? Math.PI : 0, alpha: 0.2, tint: '#000' });
  }
  if (by >= 0) {
    const h = clamp(by, 0, 10);
    const sc = Math.max(0, 0.2 * remap(by, 0, 5, 1, 0.5));
    const d = 10.32 * sc;
    if (d > 0)
      sprite(IMGS.disc, bp[0] + 0.8 * h, bp[2], d, d, { alpha: 0.2, tint: '#000' });
  }
  if (!below) drawBall();
  sprite(IMGS.racket, rackets[1].pos[0], rackets[1].pos[2], (IMGS.racket && IMGS.racket.width ? IMGS.racket.width : 414) / 100, (IMGS.racket && IMGS.racket.height ? IMGS.racket.height : 542) / 100, { tint: '#FF5F57' });
  sprite(IMGS.racket, rackets[2].pos[0], rackets[2].pos[2], (IMGS.racket && IMGS.racket.width ? IMGS.racket.width : 414) / 100, (IMGS.racket && IMGS.racket.height ? IMGS.racket.height : 542) / 100, { rot: Math.PI, tint: '#00D0FF' });

  // scores
  function drawScore(val, z) {
    const flip = MY.role === 2;
    ctx.save();
    ctx.translate(flip ? halfW - 2.2 : -halfW + 2.2, z);
    if (flip) ctx.rotate(Math.PI);
    ctx.scale(1, -1);
    ctx.font = 'bold 4.2px system-ui, Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 0.35;
    ctx.strokeStyle = '#000';
    ctx.fillStyle = '#fff';
    const v = val != null ? val : 0;
    ctx.strokeText(v, 0, 0);
    ctx.fillText(v, 0, 0);
    ctx.restore();
  }
  drawScore(UI.scores[1], 16.5);
  drawScore(UI.scores[0], -16.5);

  // serve hint
  if (phase === 'playing' && UI.serving && MY.role === UI.server) {
    ctx.save();
    if (MY.role === 2) ctx.rotate(Math.PI);
    ctx.scale(1, -1);
    ctx.font = 'bold 1.3px system-ui, Arial';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#000';
    ctx.globalAlpha = 0.6;
    const z = 15.5;
    ctx.fillText('Your serve: hit the ball', 0, z);
    ctx.restore();
  }
}

// ---- HUD / debug ----
function updateHud() {
  const now = performance.now();
  if (!NET.snapLast) return;
  // rate calc simple
  $('hud').textContent = 'rtt ' + NET.rtt + 'ms · snap ' + NET.snapRate + '/s · corr ' + NET.corrections;
}
let snapCountAcc = 0, snapRateTimer = 0;
function updateSnapRate(dt) {
  snapCountAcc += (NET.snapCount || 0);
  // NET.snapCount reset in onSnapshot? We'll track separately
}

let dbgOn = false;
function setDbg(on) {
  dbgOn = on;
  const el = $('dbg');
  el.style.display = on ? 'block' : 'none';
  if (!on) el.textContent = '';
}
addEventListener('keydown', e => { if (e.key === 'd' || e.key === 'D') setDbg(!dbgOn); });

// ---- main loop ----
let last = 0, acc = 0, snapCountPrev = 0, hudLast = 0;
function frame(ts) {
  const now = ts;
  const dt = Math.min((ts - last) / 1000 || 0, 0.05);
  last = ts;
  flushDevQueues();
  if (phase === 'playing') {
    const frameScale = 1 / 60 / Math.max(dt, 1e-4);
    for (const t of touches.values()) onKeep(t, frameScale);
    interpSnapshots(performance.now());
  }
  // snap rate
  if (!hudLast) hudLast = performance.now();
  const span = (performance.now() - hudLast) / 1000;
  if (span >= 0.5) {
    NET.snapRate = Math.round(NET.snapCount / span);
    NET.snapCount = 0;
    hudLast = performance.now();
  }
  if (phase === 'playing') {
    $('hud').style.display = 'block';
    $('hud').textContent = 'rtt ' + NET.rtt + 'ms · snap ' + NET.snapRate + '/s · corr ' + NET.corrections;
  }
  render(performance.now() / 1000);
  requestAnimationFrame(frame);
}

$('b2o').onclick = () => { initAudio(); $('netStatus').textContent = 'Connecting…'; netConnect(); };
$('again').onclick = () => netSend({ t: 'again' });
$('toMenu').onclick = () => netToMenu('');
if (QS.get('debug') === '1') setDbg(true);
addEventListener('resize', resize);
resize();
loadAll().then(() => requestAnimationFrame(frame));

window.__pp = { NET, MY, UI, RB, rackets, Sim };
