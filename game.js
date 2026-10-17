'use strict';
// Ping Pong — online-only client (full netcode plan). Server-authoritative.
const Sim = window.Sim;
const $ = id => document.getElementById(id);
const canvas = $('c'), ctx = canvas.getContext('2d');

const CAM_SIZE = 20, CAM_Z = -0.04;
const BG = '#FBCF6E';
const SCORE_TO_WIN = 7;
const RADIUS = 0.4;
const IMG_PPU_BALL = 12.4;
const LERP_RACKET = 0.5;
const SWIPE_SCALE = 0.5;
const EASE_M0 = 1.3626503944396973, EASE_M1 = 0.3367648124694824;
const ease = t => { const t2=t*t,t3=t2*t; return (t3-2*t2+t)*EASE_M0 + (-2*t3+3*t2) + (t3-t2)*EASE_M1; };
const clamp = (v,a,b) => (v<a?a:v>b?b:v);
const rand = (a,b) => a + Math.random()*(b-a);
const remap = (v,a,b,c,d) => c + ((v-a)/(b-a))*(d-c);
const lerp3 = (a,b,t) => [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t];
const r2 = v => Math.round(v*100)/100;

const MAX_INPUTS_PER_TICK = 8;
const SMOOTH_RATE = 10;
const SNAP_DIST = 2.5;

const QS = new URLSearchParams(location.search);
const DEV_LAT = Math.max(0, +QS.get('lat') || 0);
const DEV_JIT = Math.max(0, +QS.get('jit') || 0);

// ---- assets ----
const IMGS = {};
const imgList = { racket:'Racchetta_4848.png', ring:'Cerchio_128_Bucato_4663.png', disc:'Cerchio_128_4781.png', shadowBig:'Cerchio_1024_22.png', border:'Bordo_4303.png' };
let audioCtx = null, hitBuf = null;
function loadAll() {
  const ps = Object.entries(imgList).map(([k,f]) => new Promise(res => {
    const i = new Image(); i.onload = () => { IMGS[k]=i; res(); }; i.onerror = res; i.src = 'assets/'+f;
  }));
  return Promise.all(ps);
}
function initAudio() {
  if (audioCtx) { if (audioCtx.state==='suspended') audioCtx.resume(); return; }
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    fetch('assets/hit.wav').then(r=>r.arrayBuffer()).then(b=>audioCtx.decodeAudioData(b)).then(b=>{hitBuf=b;}).catch(()=>{});
  } catch(e){ audioCtx=null; }
}
function playHit() {
  if (!audioCtx || !hitBuf) return;
  const s = audioCtx.createBufferSource();
  s.buffer = hitBuf;
  s.playbackRate.value = rand(0.9,1.1);
  s.connect(audioCtx.destination);
  s.start();
}

// ---- state ----
const NET = { ws:null, connecting:false, pingTimer:null, rtt:0, offset:null, snapLast:0, jitter:0, snapCount:0, snapRate:0, corrections:0 };
const MY = { role:0, seq:0, token:null };
let P = null;
const inputs = [];
let holdPointer = null;
const SNAP = new Snap.SnapshotInterpolation(25);
const smooth = { x:0, y:0, z:0 };
let wasPredicting = false;
const RB = { x:0, y:2, z:-8 };
let oppRender = { pos:[0,2,8], params:{spin:0,dir:0,pot:0} };
const UI = { phase:'menu', scores:[0,0], server:1, serveTicks:0, serving:true, winner:0 };
let hudLast = 0;
const G = { trail:[], bursts:[], time:0 };

// dev latency queues
const outQ=[], inQ=[]; let outAt=0, inAt=0;
function rawSend(m){ if (NET.ws && NET.ws.readyState===1) NET.ws.send(JSON.stringify(m)); }
function netSend(m){
  if (!DEV_LAT && !DEV_JIT) return rawSend(m);
  const now = performance.now();
  outAt = Math.max(outAt+0.5, now + Math.max(0, DEV_LAT + (DEV_JIT?rand(-DEV_JIT,DEV_JIT):0)));
  outQ.push({at:outAt, m});
}
function netConnect(){
  NET.connecting = true;
  let url;
  if (location.protocol.startsWith('http')) url = (location.protocol==='https:'?'wss://':'ws://')+location.host;
  else url = 'ws://localhost:8080';
  try { NET.ws = new WebSocket(url); } catch(e){ netFail('Connection failed'); return; }
  NET.ws.onopen = () => { rawSend({t:'join', v:1}); $('netStatus').textContent='Waiting for opponent…'; };
  NET.ws.onmessage = e => {
    if (DEV_LAT || DEV_JIT) {
      const now = performance.now();
      inAt = Math.max(inAt+0.5, now + Math.max(0, DEV_LAT + (DEV_JIT?rand(-DEV_JIT,DEV_JIT):0)));
      inQ.push({at:inAt, s:e.data});
    } else { try { netMessage(JSON.parse(e.data)); } catch(err){} }
  };
  NET.ws.onclose = netClosed;
  NET.ws.onerror = () => {};
}
function netFail(msg){ NET.connecting=false; menuButtons(false); $('netStatus').textContent=msg; }
function netClosed(){
  NET.ws=null;
  if (MY.role) return netToMenu('Connection lost');
  if (NET.connecting) netFail('Connection failed');
}
function netToMenu(msg){
  MY.role=0; MY.token=null; MY.seq=0;
  P=null; inputs.length=0; holdPointer=null; hudLast=0;
  clearInterval(NET.pingTimer); NET.pingTimer=null;
  outQ.length=0; inQ.length=0;
  if (NET.ws){ const ws=NET.ws; NET.ws=null; try{ws.close();}catch(e){} }
  UI.phase='menu'; G.trail=[]; G.bursts=[];
  $('hud').style.display='none'; $('ping').style.display='none';
  $('over').classList.add('hidden'); $('menu').classList.remove('hidden');
  $('again').style.display='';
  menuButtons(false);
  $('netStatus').textContent=msg;
}
function menuButtons(disabled){ ['b2o'].forEach(id=>{ const el=$(id); if(el) el.disabled=disabled; }); }
function netMessage(m){
  switch(m.t){
    case 'room': NET.connecting=false; MY.role = m.role==='p1'?1:2; break;
    case 'start': startMatch(m); break;
    case 's': if (P) onSnapshot(m); break;
    case 'e': if (P) onEvents(m); break;
    case 'ping': rawSend({t:'pong', ts:m.ts, time:Date.now()}); break;
    case 'pong': {
      NET.rtt = Math.max(0, Math.round(performance.now()-m.ts));
      if (typeof m.time==='number'){ const off = m.time + NET.rtt/2 - Date.now(); NET.offset = NET.offset===null?off:NET.offset+(off-NET.offset)*0.1; }
      const el=$('ping'); el.style.display='block'; el.textContent=NET.rtt+' ms';
      break;
    }
    case 'opp_left': netToMenu('Opponent left'); break;
    case 'ver': netFail('Please refresh — the server was updated'); break;
  }
}
function pingServer(){ netSend({t:'ping', ts:performance.now()}); }

// ---- match start ----
function startMatch(m){
  MY.token = m.token;
  P = Sim.load(m.S);
  inputs.length=0; MY.seq=0; holdPointer=null;
  SNAP.vault.clear();
  smooth.x=smooth.y=smooth.z=0;
  wasPredicting=false; NET.corrections=0; hudLast=0;
  RB.x=P.ball.pos[0]; RB.y=P.ball.pos[1]; RB.z=P.ball.pos[2];
  UI.phase=P.phase; UI.scores=[P.scores[1],P.scores[2]]; UI.server=P.server; UI.serveTicks=P.serveTicks; UI.serving=P.ball.serving; UI.winner=P.winner;
  oppRender = { pos: P.rackets[MY.role===1?2:1].pos.slice(), params: {...P.rackets[MY.role===1?2:1].params} };
  G.trail=[]; G.bursts=[]; G.time=0; acc=0;
  $('menu').classList.add('hidden'); $('over').classList.add('hidden');
  $('again').style.display='';
  $('netStatus').textContent='';
  $('hud').style.display='block';
  clearInterval(NET.pingTimer);
  NET.pingTimer = setInterval(pingServer, 2000);
  pingServer();
}

// ---- input stream ----
function sendInput(k, x, z){
  MY.seq++;
  const e = { seq:MY.seq, p: MY.role, k, x: x===undefined?0:r2(x), z: z===undefined?0:r2(z), tick:P.tick, used:false };
  inputs.push(e);
  if (inputs.length > 240) inputs.splice(0, inputs.length-240);
  netSend({ t:'i', seq:e.seq, k, x:e.x, z:e.z, token:MY.token });
}
let lastMoveSend = 0;

// ---- prediction ----
function shouldPredict(){ return !!P && P.phase==='playing'; }

function simTick(){
  const t = P.tick + 1;
  const batch = [];
  for (let i=0; i<inputs.length && batch.length<MAX_INPUTS_PER_TICK; i++){
    const e = inputs[i];
    if (!e.used && e.tick <= t){ e.used=true; batch.push(e); }
  }
  Sim.step(P, batch);
  P.events.length = 0;
}

function onSnapshot(m){
  const now = performance.now();
  if (NET.snapLast){ const d = Math.abs((now-NET.snapLast)- (1000/25)); NET.jitter += (d-NET.jitter)*0.1; }
  NET.snapLast = now; NET.snapCount++;
  // vault: ball + opponent racket
  const oppIdx = MY.role===1 ? 1 : 0; // m.r index (0=p1,1=p2); opponent racket index
  const rr = (m.r && m.r[oppIdx]) || [0,2,0,0,0,0];
  SNAP.snapshot.add({ id:'oppFrame', time:m.tm, state:[
    { id:'opp', x:rr[0], y:rr[1], z:rr[2], spin:rr[3], dir:rr[4], pot:rr[5] },
  ]});
  // UI state
  UI.phase = m.ph; UI.scores = [m.sc[0], m.sc[1]]; UI.winner = m.w; UI.server = m.sv; UI.serveTicks = m.st; UI.serving = !!(m.b && m.b[10]);
  reconcile(m);
  if (m.ph==='over' && UI.phase==='over') {
    $('overTitle').textContent = m.w===1 ? 'Red wins!' : 'Blue wins!';
    setTimeout(()=>{ if (UI.phase==='over') $('over').classList.remove('hidden'); }, 600);
  } else if (m.ph==='playing') { $('over').classList.add('hidden'); }
}

function reconcile(m){
  const A = (m.a && m.a[MY.role-1]) || 0;
  const pre = { x:P.ball.pos[0], y:P.ball.pos[1], z:P.ball.pos[2] };
  const preRacket = P.rackets[MY.role] ? P.rackets[MY.role].pos.slice() : null;
  const preRacketParams = P.rackets[MY.role] ? { ...P.rackets[MY.role].params } : null;
  const Tc = P.tick;
  for (let i=inputs.length-1; i>=0; i--) if (inputs[i].seq <= A) inputs.splice(i,1);
  Sim.applySnapshot(P, m);
  for (const e of inputs){ e.used=false; if (e.tick <= m.tk) e.tick = m.tk+1; }
  inputs.sort((a,b)=> a.tick-b.tick || a.seq-b.seq);
  let idx=0;
  for (let t=m.tk+1; t<=Tc; t++){
    const batch=[];
    while (idx<inputs.length && inputs[idx].tick<=t && batch.length<MAX_INPUTS_PER_TICK){ inputs[idx].used=true; batch.push(inputs[idx]); idx++; }
    Sim.step(P, batch);
  }
  P.events.length=0;
  if (shouldPredict()){
    smooth.x += pre.x - P.ball.pos[0]; smooth.y += pre.y - P.ball.pos[1]; smooth.z += pre.z - P.ball.pos[2];
    if (Math.sqrt(smooth.x*smooth.x+smooth.y*smooth.y+smooth.z*smooth.z) > SNAP_DIST){ smooth.x=smooth.y=smooth.z=0; NET.corrections++; }
    // Trust local prediction for the own racket: restore the predicted pose/params
    // so reconciliation never drags it toward the server's (delayed) position.
    if (preRacket && P.rackets[MY.role]) {
      P.rackets[MY.role].pos = preRacket.slice();
      if (preRacketParams) P.rackets[MY.role].params = { ...preRacketParams };
    }
  }
}

function onEvents(m){
  for (let i=0;i<m.evs.length;i++){
    const ev=m.evs[i];
    if (ev.ev==='hit' || ev.ev==='bounce') playHit();
  }
}

// ---- input ----
function toWorld(e){
  const r = canvas.getBoundingClientRect();
  const sx = ((e.clientX-r.left)/r.width)*W;
  const sy = ((e.clientY-r.top)/r.height)*H;
  let wx, wz;
  if (MY.role === 1) {
    wx = (sx-W/2)/S; wz = (H/2 - sy)/S + CAM_Z;
  } else {
    wx = (W/2 - sx)/S; wz = (sy - H/2)/S + CAM_Z;
  }
  wx = clamp(wx, -halfW, halfW);
  return [wx, wz];
}
canvas.addEventListener('pointerdown', e => {
  initAudio();
  if (!P) return;
  const [x,z] = toWorld(e);
  holdPointer = e.pointerId;
  try { canvas.setPointerCapture(e.pointerId); } catch(err){}
  sendInput('m', x, z);
  lastMoveSend = performance.now();
  e.preventDefault();
});
canvas.addEventListener('pointermove', e => {
  if (holdPointer !== e.pointerId) return;
  const [x,z] = toWorld(e);
  const now = performance.now();
  if (now - lastMoveSend >= 16) {
    sendInput('m', x, z);
    lastMoveSend = now;
  }
  e.preventDefault();
});
function pointerEnd(e){
  if (holdPointer !== e.pointerId) return;
  holdPointer = null;
  sendInput('u');
}
canvas.addEventListener('pointerup', pointerEnd);
canvas.addEventListener('pointercancel', pointerEnd);

// ---- per-frame update ----
let W=1,H=1,S=1,halfW=11.25,acc=0,last=0;
function resize(){
  const vw=innerWidth, vh=innerHeight;
  const w=Math.min(vw, Math.round((vh*9)/16)), h=vh;
  const dpr=Math.min(devicePixelRatio||1,2);
  canvas.width=Math.round(w*dpr); canvas.height=Math.round(h*dpr);
  canvas.style.width=w+'px'; canvas.style.height=h+'px';
  const st=$('stage'); st.style.width=w+'px'; st.style.height=h+'px';
  W=canvas.width; H=canvas.height; S=H/(CAM_SIZE*2);
  halfW=(W/H)*CAM_SIZE;
}
addEventListener('resize', resize);

function updateRenderBall(dt){
  const tx = P.ball.pos[0], ty = P.ball.pos[1], tz = P.ball.pos[2];
  const dec = Math.exp(-dt*SMOOTH_RATE);
  smooth.x *= dec; smooth.y *= dec; smooth.z *= dec;
  RB.x = tx + smooth.x; RB.y = ty + smooth.y; RB.z = tz + smooth.z;
}
function updateTrail(){
  if (UI.phase==='playing') {
    const tr=G.trail; const p=RB;
    const lp = tr[tr.length-1];
    if (!lp || Math.hypot(p[0]-lp.x, p[2]-lp.z) >= 0.1) tr.push({x:p[0], z:p[2], t:G.time});
    while (tr.length && G.time - tr[0].t > 0.3) tr.shift();
  }
}
function updateHud(){
  const now=performance.now();
  if (!hudLast){ hudLast=now; return; }
  const span=(now-hudLast)/1000;
  if (span < 0.25) return;
  NET.snapRate = Math.round(NET.snapCount/span);
  NET.snapCount=0; hudLast=now;
  $('hud').textContent = 'rtt '+NET.rtt+'ms · snap '+NET.snapRate+'/s · jit '+Math.round(NET.jitter)+'ms · corr '+NET.corrections + (DEV_LAT||DEV_JIT?' · LAT SIM':'');
}
let dbgOn=false;
function setDbg(on){ dbgOn=on; const el=$('dbg'); el.style.display=on?'block':'none'; if(!on) el.textContent=''; }
addEventListener('keydown', e=>{ if(e.key==='d'||e.key==='D') setDbg(!dbgOn); });
let dbgAcc=0;
function updateDebug(dt){
  if (!dbgOn) return;
  const el=$('dbg'); dbgAcc+=dt; if (dbgAcc<0.1) return; dbgAcc=0;
  const now=performance.now();
  const age = NET.snapLast ? Math.round(now-NET.snapLast) : -1;
  const B = P && P.ball;
  const mode = !P ? 'no-state' : (shouldPredict()?'PREDICT':'INTERP');
  const speed = B ? Math.sqrt(B.pos[0]*0+B.pos[1]*0+0) : 0;
  const L=[];
  L.push('p'+(MY.role||'-')+' ph '+UI.phase+' ws '+(NET.ws?(NET.ws.readyState===1?'open':'state'+NET.ws.readyState):'none')+' snap '+NET.snapRate+'/s last '+(age<0?'-':age+'ms')+(age>250?' STALE!':'')+' vault '+SNAP.vault.size+' '+mode);
  L.push('rtt '+NET.rtt+'ms jit '+Math.round(NET.jitter)+'ms corr '+NET.corrections);
  if (B){ L.push('ball '+B.pos[0].toFixed(2)+','+B.pos[1].toFixed(2)+','+B.pos[2].toFixed(2)+' hitter '+B.hitter+' last '+B.last+' serving '+(B.serving?1:0)+' touching '+(B.touching||'-')+' tick '+P.tick); }
  L.push('RB '+RB.x.toFixed(2)+','+RB.y.toFixed(2)+','+RB.z.toFixed(2)+' ptr '+(holdPointer===null?'-':'held'));
  el.textContent = L.join('\n');
}
function flushDevQueues(){
  if (!DEV_LAT && !DEV_JIT) return;
  const now=performance.now();
  while (outQ.length && outQ[0].at<=now) rawSend(outQ.shift().m);
  while (inQ.length && inQ[0].at<=now){ const p=inQ.shift(); try { netMessage(JSON.parse(p.s)); } catch(e){} }
}

// ---- rendering ----
const tintCache = new Map();
function tinted(img, color){
  const key=img.src+color; let c=tintCache.get(key); if (c) return c;
  c=document.createElement('canvas'); c.width=img.width; c.height=img.height;
  const g=c.getContext('2d'); g.drawImage(img,0,0);
  g.globalCompositeOperation='multiply'; g.fillStyle=color; g.fillRect(0,0,c.width,c.height);
  g.globalCompositeOperation='destination-in'; g.drawImage(img,0,0);
  tintCache.set(key,c); return c;
}
function sprite(img,x,z,w,h,opt={}){
  ctx.save(); ctx.translate(x,z); ctx.scale(1,-1);
  if (opt.rot) ctx.rotate(opt.rot);
  ctx.globalAlpha = opt.alpha==null?1:opt.alpha;
  ctx.drawImage(opt.tint?tinted(img,opt.tint):img, -w/2, -h/2, w, h);
  ctx.restore();
}
function slice9(img,x,z,w,h,b,srcB,color){
  const src=tinted(img,color), iw=img.width, ih=img.height;
  const xs=[0,srcB,iw-srcB,iw], ys=[0,srcB,ih-srcB,ih];
  const xd=[-w/2,-w/2+b,w/2-b,w/2], yd=[-h/2,-h/2+b,h/2-b,h/2];
  ctx.save(); ctx.translate(x,z); ctx.scale(1,-1);
  for (let j=0;j<3;j++) for (let i=0;i<3;i++)
    ctx.drawImage(src, xs[i], ys[j], xs[i+1]-xs[i], ys[j+1]-ys[j], xd[i], yd[j], xd[i+1]-xd[i], yd[j+1]-yd[j]);
  ctx.restore();
}
function rect(x,z,w,h,color,alpha=1){ ctx.globalAlpha=alpha; ctx.fillStyle=color; ctx.fillRect(x-w/2,z-h/2,w,h); ctx.globalAlpha=1; }
function ballScale(y){ if (y>=5) return 1.4; if (y>1) return 1+((y-1)/4)*0.4; if (y>=-1) return 1; if (y>-5) return 1-((-1-y)/4)*0.3; return 0.7; }
function drawTrail(now){
  const T=0.3, tr=G.trail;
  while (tr.length && now-tr[0].t>T) tr.shift();
  if (tr.length<2) return;
  ctx.fillStyle='#fff';
  for (let i=0;i<tr.length-1;i++){
    const a=tr[i], b=tr[i+1];
    const ageA=(now-a.t)/T, ageB=(now-b.t)/T;
    const wA=1.5*(1-ageA)*0.5, wB=1.5*(1-ageB)*0.5;
    const dx=b.x-a.x, dz=b.z-a.z, l=Math.hypot(dx,dz)||1;
    const nx=-dz/l, nz=dx/l;
    const age=(ageA+ageB)/2, head=1-age;
    ctx.globalAlpha = head<0.57 ? head/0.57 : 1;
    ctx.beginPath();
    ctx.moveTo(a.x+nx*wA, a.z+nz*wA);
    ctx.lineTo(b.x+nx*wB, b.z+nz*wB);
    ctx.lineTo(b.x-nx*wB, b.z-nz*wB);
    ctx.lineTo(a.x-nx*wA, a.z-nz*wA);
    ctx.closePath(); ctx.fill();
  }
  ctx.globalAlpha=1;
}
function render(now){
  ctx.setTransform(1,0,0,1,0,0);
  ctx.fillStyle=BG; ctx.fillRect(0,0,W,H);
  const flip = MY.role===2;
  if (flip) ctx.setTransform(-S,0,0,S,W/2,H/2-CAM_Z*S);
  else ctx.setTransform(S,0,0,-S,W/2,H/2+CAM_Z*S);
  const bp=RB, by=bp.y;
  const bs=ballScale(by), below=by<0;
  const drawBall=()=>{
    sprite(IMGS.ring, bp.x, bp.z, 10.32*0.18*bs, 10.32*0.18*bs, {tint:'#000'});
    sprite(IMGS.disc, bp.x, bp.z, 10.32*0.1*bs, 10.32*0.1*bs);
  };
  const drawTable=()=>{
    slice9(IMGS.border,0,0,8.18*1.5,14.7*1.5,0.5*1.5,50,'#000');
    rect(0,0,10.968911,20.755992,'#76CA3E');
    rect(0,0,0.64,20.756,'#fff');
    rect(0,0,10.9888,0.8048,'#000');
    rect(0,0,10.9888,0.1989,'#fff');
  };
  sprite(IMGS.shadowBig, bp.x+0.3, bp.z, 10.24*0.12, 10.24*0.12, {alpha:0.2, tint:'#000'});
  if (below) drawBall();
  drawTable();
  drawTrail(now);
  // racket shadows
  if (P) for (const p of [1,2]){
    const r = (p === MY.role) ? P.rackets[p].pos : oppRender.pos;
    sprite(IMGS.racket, r[0]+0.5, r[2], IMGS.racket.width/100, IMGS.racket.height/100, {rot: p===2?Math.PI:0, alpha:0.2, tint:'#000'});
  }
  if (by>=0){ const h=clamp(by,0,10); const sc=Math.max(0,0.2*remap(by,0,5,1,0.5)); const d=10.32*sc; if (d>0) sprite(IMGS.disc, bp.x+0.8*h, bp.z, d, d, {alpha:0.2, tint:'#000'}); }
  if (!below) drawBall();
  // rackets
  if (P) {
    const r1pos = (MY.role===1) ? P.rackets[1].pos : oppRender.pos;
    const r2pos = (MY.role===2) ? P.rackets[2].pos : oppRender.pos;
    sprite(IMGS.racket, r1pos[0], r1pos[2], IMGS.racket.width/100, IMGS.racket.height/100, {tint:'#FF5F57'});
    sprite(IMGS.racket, r2pos[0], r2pos[2], IMGS.racket.width/100, IMGS.racket.height/100, {rot:Math.PI, tint:'#00D0FF'});
  }

  function drawScore(val, z) {
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

  // serve hint (drawn in screen space so it always sits at the bottom)
  if (UI.phase === 'playing' && UI.serving && ((MY.role === 1 && UI.server === 1) || (MY.role === 2 && UI.server === 2))) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = 'bold 18px system-ui, Arial';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#000';
    ctx.globalAlpha = 0.6;
    ctx.fillText('Your serve: hit the ball', W / 2, H - 40);
    ctx.restore();
  }
}

// ---- frame loop ----
function frame(ts){
  const dt = Math.min((ts-last)/1000 || 0, 0.05); last=ts;
  G.time += dt;
  flushDevQueues();
  if (P){
    acc = Math.min(acc+dt, 0.2);
    while (acc >= Sim.FIXED){ acc -= Sim.FIXED; simTick(); }
    updateRenderBall(dt);
    // update oppRender via interpolation
    const it = SNAP.calcInterpolation('x y z spin dir pot');
    if (it && it.state && it.state[0]){ oppRender.pos = [it.state[0].x, it.state[0].y, it.state[0].z]; oppRender.params = { spin:it.state[0].spin, dir:it.state[0].dir, pot:it.state[0].pot }; }
    updateTrail();
    updateHud();
  }
  updateDebug(dt);
  G.bursts = G.bursts.filter(p=>{ p.t+=dt; p.x+=p.vx*dt; p.z+=p.vz*dt; return p.t<p.life; });
  render(G.time);
  requestAnimationFrame(frame);
}

$('b2o').onclick = () => { initAudio(); menuButtons(true); $('netStatus').textContent='Connecting…'; netConnect(); };
$('again').onclick = () => netSend({t:'again'});
$('toMenu').onclick = () => netToMenu('');
if (QS.get('debug')==='1') setDbg(true);
addEventListener('resize', resize);
resize();
Promise.all(Object.entries(imgList).map(([k,f])=> new Promise(res=>{ const im=new Image(); im.onload=()=>{ IMGS[k]=im; res(); }; im.onerror=res; im.src='assets/'+f; }))).then(()=>requestAnimationFrame(frame));

window.__pp = { NET, MY, UI, G, RB, inputs, get oppRender(){ return oppRender; }, SNAP, get P(){ return P; }, Sim };