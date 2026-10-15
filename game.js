'use strict';
// Ping Pong - web port of JungleFrog.NPlayers.PingPong (values taken from the shipped APK, see notes in README comments).
const $ = id => document.getElementById(id);
const canvas = $('c'),
  ctx = canvas.getContext('2d');

// ---- constants from the prefab / IL2CPP code ----
const FIXED = 1 / 50; // Unity default fixedDeltaTime
const CAM_SIZE = 20,
  CAM_Z = -0.04; // orthographic size, camera z
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
const CENTER = { 1: [0, -6, 5], 2: [0, -6, -5] }; // landing centre for a shot from player 1 / player 2
const SERVE = { 1: [0, 2, -8], 2: [0, 2, 8] };
const TABLE = { hx: 6.08, hz: 10.96, top: 0 }; // BoxCollider 12.16 x 1.2 x 21.92 at y -0.6
const IMG_PPU_BALL = 12.4;
const LERP_RACKET = 0.5;
// Multiplier on swipe delta; the original per-frame touch delta is not reproduced exactly.
const SWIPE_SCALE = 0.5;

// AnimationCurve curvaAnimazione: Hermite (0,0,m=1.36265) -> (1,1,m=0.336765)
const EASE_M0 = 1.3626503944396973,
  EASE_M1 = 0.3367648124694824;
const ease = t => {
  const t2 = t * t,
    t3 = t2 * t;
  return (t3 - 2 * t2 + t) * EASE_M0 + (-2 * t3 + 3 * t2) + (t3 - t2) * EASE_M1;
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rand = (a, b) => a + Math.random() * (b - a);
const remap = (v, a, b, c, d) => c + ((v - a) / (b - a)) * (d - c);
const lerp3 = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

// ---- assets ----
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

// ---- game state ----
let mode = 'cpu',
  difficultyName = 'medium';
let phase = 'menu'; // menu | playing | over
const scores = { 1: 0, 2: 0 };
let server = 1;
let diff = 0.5; // LevelController.difficultyCalculated
let serveTimer = null;

function makeRacket(player) {
  return {
    player,
    cpu: false,
    pos: [0, player === 1 ? 2 : 2.89, player === 1 ? -12 : 12],
    old: [0, 0, 0],
    params: { spin: 0, dir: 0, pot: 0 },
    velCPU: player === 2 ? 0.15 : 2,
    interval: [0.15, 0.2],
    offset: [0, 0, 0],
    capZ: player === 1 ? 0.66 : -0.66,
  };
}
const rackets = { 1: makeRacket(1), 2: makeRacket(2) };

const ball = {
  pos: [0, 2, -8],
  old: [0, 2, -8],
  vel: [0, 0, 0],
  dir: [0, 0, 0],
  tw: null,
  bez: null,
  hitter: null,
  last: 2,
  serving: true,
  touching: null,
  trail: [],
};

// ---- helpers: CPU ----
function randomizeOffset(r) {
  if (Math.random() >= 0.125) {
    r.offset = [0, 0, 0];
    return;
  }
  let x, z;
  do {
    x = rand(-1, 1);
    z = rand(-1, 1);
  } while (x * x + z * z > 1);
  r.offset = [x * 2, 0, z * 2];
}
function cpuCaso(r) {
  randomizeOffset(r);
  r.params.dir = rand(-0.8, 0.8);
  r.velCPU = rand(r.interval[0], r.interval[1]);
  r.params.pot = diff;
}

// ---- view ----
let W = 0,
  H = 0,
  S = 1,
  halfW = 11.25;
function resize() {
  const vw = innerWidth,
    vh = innerHeight;
  const w = Math.min(vw, Math.round((vh * 9) / 16)),
    h = vh;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const st = $('stage');
  st.style.width = w + 'px';
  st.style.height = h + 'px';
  W = canvas.width;
  H = canvas.height;
  S = H / (CAM_SIZE * 2);
  halfW = (W / H) * CAM_SIZE;
}
addEventListener('resize', resize);
const toWorld = e => {
  const r = canvas.getBoundingClientRect();
  const sx = ((e.clientX - r.left) / r.width) * W,
    sy = ((e.clientY - r.top) / r.height) * H;
  return [(sx - W / 2) / S, (H / 2 - sy) / S + CAM_Z]; // [x, z]
};

// ---- input (Touchable zones: bottom half = player 1, top half = player 2) ----
const touches = new Map();
canvas.addEventListener('pointerdown', e => {
  initAudio();
  if (phase !== 'playing') return;
  const [x, z] = toWorld(e);
  const player = z < 0 ? 1 : 2;
  if (player === 2 && mode === 'cpu') return;
  canvas.setPointerCapture(e.pointerId);
  touches.set(e.pointerId, { player, pos: [x, z], prev: [x, z] });
  e.preventDefault();
});
canvas.addEventListener('pointermove', e => {
  const t = touches.get(e.pointerId);
  if (t) t.pos = toWorld(e);
});
const endTouch = e => {
  const t = touches.get(e.pointerId);
  if (t) {
    touches.delete(e.pointerId);
    const p = rackets[t.player].params;
    p.spin = p.dir = p.pot = 0;
  }
};
canvas.addEventListener('pointerup', endTouch);
canvas.addEventListener('pointercancel', endTouch);

// Racchetta.OnKeep, called once per rendered frame for every held pointer
function onKeep(t, frameScale) {
  const r = rackets[t.player];
  if (phase !== 'playing' || r.cpu) return;
  const dx = (t.pos[0] - t.prev[0]) * frameScale * SWIPE_SCALE,
    dz = (t.pos[1] - t.prev[1]) * frameScale * SWIPE_SCALE;
  t.prev = t.pos.slice();
  let tz = t.pos[1];
  tz = t.player === 1 ? clamp(tz, -20, -5) : clamp(tz, 5, 20);
  const k = clamp(LERP_RACKET, 0, 1);
  r.pos[0] += (t.pos[0] - r.pos[0]) * k;
  r.pos[1] += (2 - r.pos[1]) * k;
  r.pos[2] += (tz - r.pos[2]) * k;
  r.params.spin = clamp(dx, -1, 1);
  r.params.pot = t.player === 1 ? clamp(dz, -0.5, 1) : -clamp(dz, -1, 0.5);
  const m = Math.hypot(dx, 0, dz);
  r.params.dir = m <= 1e-5 ? 0 : dx / m;
}

// ---- Racchetta.FixedUpdate (CPU) ----
function racketFixed(r) {
  r.vel = [r.pos[0] - r.old[0], r.pos[1] - r.old[1], r.pos[2] - r.old[2]];
  if (r.cpu && phase === 'playing') {
    const bp = ball.pos;
    let tx = clamp(bp[0], -halfW, halfW),
      tz;
    if (!ball.serving) {
      if (bp[2] >= 0) tz = clamp(bp[2] + 4, 10, 20);
      else tz = 15;
    } else tz = 8;
    let ty = 0;
    if (!ball.serving) {
      tx += r.offset[0];
      ty += r.offset[1];
      tz += r.offset[2];
    }
    tx = clamp(tx, -halfW, halfW);
    const f = clamp(diff * r.velCPU, 0, 1);
    r.pos[0] += (tx - r.pos[0]) * f;
    r.pos[1] += (ty - r.pos[1]) * f;
    r.pos[2] += (tz - r.pos[2]) * f;
  }
  r.old = r.pos.slice();
}

// ---- collision queries (physics layers: rackets + table) ----
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
  return Math.hypot(c[0] - cc[0], c[1] - y, c[2] - cc[2]) <= rad + r;
}
function overlapRacket(r, p) {
  if (sphereBox(p, RADIUS, r.pos, [2, 5, 2.25])) return true;
  return sphereCapsuleY(
    p,
    RADIUS,
    [r.pos[0], r.pos[1], r.pos[2] + r.capZ],
    1.67,
    (10 - 2 * 1.67) / 2,
  );
}
function overlapTable(p) {
  return sphereBox(p, RADIUS, [0, -0.6, 0], [TABLE.hx, 0.6, TABLE.hz]);
}

// ---- Pallina ----
function bezAt(b, t) {
  const u = 1 - t,
    a = u * u * u,
    c = 3 * u * u * t,
    d = 3 * u * t * t,
    e = t * t * t;
  return [0, 1, 2].map(
    i => a * b.p0[i] + c * b.p1[i] + d * b.p2[i] + e * b.p3[i],
  );
}

function startFlight(p3, dur) {
  const p0 = ball.pos.slice();
  const a = [p0[0], 0, p0[2]],
    b = [p3[0], 0, p3[2]];
  const h0 = lerp3(a, b, 0.2);
  h0[1] = ARC;
  const h1 = [p3[0], ARC, p3[2]];
  ball.bez = { p0, p1: h0, p2: h1, p3: p3.slice() };
  ball.tw = { t: 0, dur: dur };
}

let tempoAnimazione = T0;
function collisione(tipo) {
  if (tipo === 2) {
    if (ball.vel[1] > 0) return;
    const p3 = [
      ball.pos[0] + ball.dir[0] * BOUNCE,
      ball.pos[1] + FLOOR,
      ball.pos[2] + ball.dir[2] * BOUNCE,
    ];
    ball.last = 2;
    startFlight(p3, tempoAnimazione);
    playHit();
    return;
  }
  if (ball.last < 2) return;
  const r = tipo === 1 ? rackets[1] : rackets[2];
  ball.hitter = r;
  if (tipo === 0 && r.cpu) cpuCaso(r);
  const pr = r.params;
  const x = pr.dir * MOD_DIR * remap(pr.pot, 0, 1, 0.7, 1.0);
  const c = CENTER[tipo === 1 ? 1 : 2];
  const z = tipo === 1 ? c[2] + pr.pot * MOD_POW : c[2] - pr.pot * MOD_POW;
  tempoAnimazione = T0 + pr.pot * -0.2;
  ball.last = tipo;
  ball.serving = false;
  startFlight([x, c[1], z], tempoAnimazione);
  playHit();
}

function ballFixed() {
  if (ball.bez && ball.hitter)
    ball.bez.p3[0] += ball.hitter.params.spin * MOD_SPIN;
  const p = ball.pos;
  ball.vel = [p[0] - ball.old[0], p[1] - ball.old[1], p[2] - ball.old[2]];
  const m = Math.hypot(ball.vel[0], ball.vel[1], ball.vel[2]);
  ball.dir =
    m <= 1e-5 ? [0, 0, 0] : [ball.vel[0] / m, ball.vel[1] / m, ball.vel[2] / m];
  let hit = null;
  if (overlapRacket(rackets[2], p)) hit = 'n';
  else if (overlapRacket(rackets[1], p)) hit = 's';
  else if (overlapTable(p)) hit = 't';
  if (hit && hit !== ball.touching)
    collisione(hit === 'n' ? 0 : hit === 's' ? 1 : 2);
  ball.touching = hit;
  ball.old = ball.pos.slice();
}

function ballTween(dt) {
  const tw = ball.tw;
  if (!tw) return;
  tw.t += dt;
  const k = Math.min(tw.t / tw.dur, 1);
  ball.pos = bezAt(ball.bez, ease(k));
  if (k >= 1) {
    ball.tw = null;
    pallinaCaduta();
  }
}

function pallinaCaduta() {
  let scorer = 0;
  const nord = ball.hitter === rackets[2],
    sud = ball.hitter === rackets[1];
  if (ball.last === 2) {
    if (nord) scorer = 2;
    else if (sud) scorer = 1;
  } else {
    if (nord) scorer = 1;
    else if (sud) scorer = 2;
  }
  if (scorer) punto(scorer);
}

function punto(player) {
  scores[player]++;
  recalcDifficulty();
  if (scores[1] < SCORE_TO_WIN && scores[2] < SCORE_TO_WIN) {
    if ((scores[1] + scores[2]) % 2 === 0) server = server === 1 ? 2 : 1;
    serveTimer = 1.0;
  } else {
    phase = 'over';
    touches.clear();
    $('overTitle').textContent =
      mode === 'cpu'
        ? player === 1
          ? 'You win!'
          : 'You lose'
        : player === 1
          ? 'Red wins!'
          : 'Blue wins!';
    $('over').classList.remove('hidden');
  }
}

function servizio() {
  ball.serving = true;
  ball.tw = null;
  ball.last = 2;
  ball.trail.length = 0;
  if (rackets[1].cpu) randomizeOffset(rackets[1]);
  if (rackets[2].cpu) randomizeOffset(rackets[2]);
  ball.pos = SERVE[server].slice();
  ball.old = ball.pos.slice();
  ball.touching = null;
}

// LevelController.CalculateDifficulty (type 1): rubber-banding on score difference (player 1 minus player 2)
const INTERVALS = { easy: [0.3, 0.5], medium: [0.4, 0.6], hard: [0.85, 1.0] };
const EXTREME_DIFF = 3;
function recalcDifficulty() {
  const iv = INTERVALS[difficultyName];
  const n =
    clamp(scores[1] - scores[2], -EXTREME_DIFF, EXTREME_DIFF) / EXTREME_DIFF;
  diff = iv[0] + (iv[1] - iv[0]) * clamp((n + 1) / 2, 0, 1);
}

function newGame(m, d) {
  mode = m;
  difficultyName = d || 'medium';
  rackets[1] = makeRacket(1);
  rackets[2] = makeRacket(2);
  rackets[2].cpu = mode === 'cpu';
  scores[1] = scores[2] = 0;
  server = 1;
  serveTimer = null;
  touches.clear();
  ball.hitter = null;
  ball.bez = null;
  tempoAnimazione = T0;
  recalcDifficulty();
  servizio();
  phase = 'playing';
  $('menu').classList.add('hidden');
  $('over').classList.add('hidden');
}

$('b1e').onclick = () => {
  initAudio();
  newGame('cpu', 'easy');
};
$('b1m').onclick = () => {
  initAudio();
  newGame('cpu', 'medium');
};
$('b1h').onclick = () => {
  initAudio();
  newGame('cpu', 'hard');
};
$('b2').onclick = () => {
  initAudio();
  newGame('2p');
};
$('again').onclick = () => newGame(mode, difficultyName);
$('toMenu').onclick = () => {
  phase = 'menu';
  $('over').classList.add('hidden');
  $('menu').classList.remove('hidden');
};

// ---- rendering ----
const tintCache = new Map();
function tinted(img, color) {
  const key = img.src + color;
  let c = tintCache.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
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
    iw = img.width,
    ih = img.height;
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

function drawTrail(now) {
  const T = 0.3,
    tr = ball.trail;
  while (tr.length && now - tr[0].t > T) tr.shift();
  if (tr.length < 2) return;
  ctx.fillStyle = '#fff';
  for (let i = 0; i < tr.length - 1; i++) {
    const a = tr[i],
      b = tr[i + 1];
    const ageA = (now - a.t) / T,
      ageB = (now - b.t) / T;
    const wA = 1.5 * (1 - ageA) * 0.5,
      wB = 1.5 * (1 - ageB) * 0.5;
    const dx = b.x - a.x,
      dz = b.z - a.z,
      l = Math.hypot(dx, dz) || 1;
    const nx = -dz / l,
      nz = dx / l;
    const age = (ageA + ageB) / 2,
      head = 1 - age;
    ctx.globalAlpha = head < 0.57 ? head / 0.57 : 1;
    ctx.beginPath();
    ctx.moveTo(a.x + nx * wA, a.z + nz * wA);
    ctx.lineTo(b.x + nx * wB, b.z + nz * wB);
    ctx.lineTo(b.x - nx * wB, b.z - nz * wB);
    ctx.lineTo(a.x - nx * wA, a.z - nz * wA);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function render(now) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  ctx.setTransform(S, 0, 0, -S, W / 2, H / 2 + CAM_Z * S);
  const bp = ball.pos,
    by = bp[1];
  const bs = ballScale(by),
    below = by < 0;
  const drawBall = () => {
    sprite(IMGS.ring, bp[0], bp[2], 10.32 * 0.18 * bs, 10.32 * 0.18 * bs, {
      tint: '#000',
    });
    sprite(IMGS.disc, bp[0], bp[2], 10.32 * 0.1 * bs, 10.32 * 0.1 * bs);
  };
  const drawTable = () => {
    slice9(IMGS.border, 0, 0, 8.18 * 1.5, 14.7 * 1.5, 0.5 * 1.5, 50, '#000');
    rect(0, 0, 10.968911, 20.755992, '#76CA3E');
    rect(0, 0, 0.64, 20.756, '#fff');
    rect(0, 0, 10.9888, 0.8048, '#000');
    rect(0, 0, 10.9888, 0.1989, '#fff');
  };

  // order -10: soft shadow under the ball
  sprite(IMGS.shadowBig, bp[0] + 0.3, bp[2], 10.24 * 0.12, 10.24 * 0.12, {
    alpha: 0.2,
    tint: '#000',
  });
  // order -5/-4: ball sorts under the table while it is below table level
  if (below) drawBall();
  // order 0..5: table
  drawTable();
  // order 6: trail
  drawTrail(now);
  // order 8: shadows
  for (const p of [1, 2]) {
    const r = rackets[p];
    sprite(
      IMGS.racket,
      r.pos[0] + 0.5,
      r.pos[2],
      IMGS.racket.width / 100,
      IMGS.racket.height / 100,
      { rot: p === 2 ? Math.PI : 0, alpha: 0.2, tint: '#000' },
    );
  }
  if (by >= 0) {
    const h = clamp(by, 0, 10);
    const sc = Math.max(0, 0.2 * remap(by, 0, 5, 1, 0.5));
    const d = 10.32 * sc;
    if (d > 0)
      sprite(IMGS.disc, bp[0] + 0.8 * h, bp[2], d, d, {
        alpha: 0.2,
        tint: '#000',
      });
  }
  // order 80/81: ball
  if (!below) drawBall();
  sprite(
    IMGS.racket,
    rackets[1].pos[0],
    rackets[1].pos[2],
    IMGS.racket.width / 100,
    IMGS.racket.height / 100,
    { tint: '#FF5F57' },
  );
  sprite(
    IMGS.racket,
    rackets[2].pos[0],
    rackets[2].pos[2],
    IMGS.racket.width / 100,
    IMGS.racket.height / 100,
    { rot: Math.PI, tint: '#00D0FF' },
  );

  // scores
  ctx.save();
  ctx.scale(1, -1);
  ctx.font = 'bold 4.2px system-ui, Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 0.35;
  ctx.strokeStyle = '#000';
  ctx.fillStyle = '#fff';
  const sx = -halfW + 2.2;
  ctx.strokeText(scores[2], sx, -16.5);
  ctx.fillText(scores[2], sx, -16.5);
  ctx.strokeText(scores[1], sx, 16.5);
  ctx.fillText(scores[1], sx, 16.5);
  ctx.restore();
  if (phase === 'playing' && ball.serving && !rackets[server].cpu) {
    ctx.save();
    ctx.scale(1, -1);
    ctx.font = 'bold 1.3px system-ui, Arial';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#000';
    ctx.globalAlpha = 0.6;
    ctx.fillText('Your serve: hit the ball', 0, server === 1 ? 15.5 : -15.5);
    ctx.restore();
  }
}

// ---- main loop ----
let last = 0,
  acc = 0;
function frame(ts) {
  const now = ts / 1000;
  let dt = Math.min(now - last, 0.1);
  last = now;
  if (phase === 'playing') {
    const frameScale = 1 / 60 / Math.max(dt, 1e-4);
    for (const t of touches.values()) onKeep(t, frameScale);
    acc += dt;
    while (acc >= FIXED) {
      acc -= FIXED;
      racketFixed(rackets[1]);
      racketFixed(rackets[2]);
      ballFixed();
    }
    ballTween(dt);
    if (serveTimer != null) {
      serveTimer -= dt;
      if (serveTimer <= 0) {
        serveTimer = null;
        servizio();
      }
    }
    const tr = ball.trail,
      p = ball.pos,
      lp = tr[tr.length - 1];
    if (!lp || Math.hypot(p[0] - lp.x, p[2] - lp.z) >= 0.1)
      tr.push({ x: p[0], z: p[2], t: now });
  }
  render(now);
  requestAnimationFrame(frame);
}

resize();
loadAll().then(() => requestAnimationFrame(frame));
