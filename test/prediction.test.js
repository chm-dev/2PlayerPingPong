'use strict';
const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const Sim = require('../sim');
const srv = require('../server');

const MAX_INPUTS_PER_TICK = 8;
class Bot {
  constructor(ws) { this.ws = ws; this.msgs = []; this.waiters = []; ws.on('message', d => { let m; try { m = JSON.parse(d); } catch (e) { return; } this.msgs.push(m); this.pump(); }); }
  pump() { for (const w of this.waiters.slice()) { const m = this.msgs.find(w.pred); if (m) { this.waiters.splice(this.waiters.indexOf(w), 1); clearTimeout(w.to); w.res(m); } } }
  waitFor(pred, timeout = 5000) { const w = { pred, res: null, to: null }; return new Promise((res, rej) => { w.res = res; w.to = setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); rej(new Error('timeout')); }, timeout); this.waiters.push(w); this.pump(); }); }
  send(m) { this.ws.send(JSON.stringify(m)); }
  close() { try { this.ws.close(); } catch (e) {} }
}
function connect(port) { return new Promise((resolve, reject) => { const ws = new WebSocket('ws://127.0.0.1:' + port); ws.on('open', () => resolve(new Bot(ws))); ws.on('error', reject); }); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function makeClient(start) {
  const c = { P: Sim.load(start.S), token: start.token, seq: 0, inputs: [], maxErr: 0, snaps: 0 };
  c.send = (k, x, z) => {
    c.seq++;
    c.inputs.push({ seq: c.seq, p: 1, k, x: x || 0, z: z || 0, tick: c.P.tick, used: false });
    c.ws.send({ t: 'i', seq: c.seq, k, x: x || 0, z: z || 0, token: c.token });
  };
  c.tick = () => {
    const t = c.P.tick + 1, batch = [];
    for (let i = 0; i < c.inputs.length && batch.length < MAX_INPUTS_PER_TICK; i++) {
      const e = c.inputs[i];
      if (!e.used && e.tick <= t) { e.used = true; batch.push(e); }
    }
    Sim.step(c.P, batch);
    c.P.events.length = 0;
  };
  c.onSnapshot = m => {
    c.snaps++;
    const A = m.a[0];
    const Tc = c.P.tick;
    for (let i = c.inputs.length - 1; i >= 0; i--) if (c.inputs[i].seq <= A) c.inputs.splice(i, 1);
    Sim.applySnapshot(c.P, m);
    for (const e of c.inputs) { e.used = false; if (e.tick <= m.tk) e.tick = m.tk + 1; }
    c.inputs.sort((a, b) => a.tick - b.tick || a.seq - b.seq);
    let idx = 0;
    for (let t = m.tk + 1; t <= Tc; t++) {
      const batch = [];
      while (idx < c.inputs.length && c.inputs[idx].tick <= t && batch.length < MAX_INPUTS_PER_TICK) { c.inputs[idx].used = true; batch.push(c.inputs[idx]); idx++; }
      if (batch.length) Sim.step(c.P, batch);
    }
    c.P.events.length = 0;
    const err = Math.sqrt((c.P.ball.pos[0] - m.b[0]) ** 2 + (c.P.ball.pos[1] - m.b[1]) ** 2 + (c.P.ball.pos[2] - m.b[2]) ** 2);
    if (err > c.maxErr) c.maxErr = err;
  };
  return c;
}

let port;
test.before(async () => { port = await srv.start(0); });
test.after(async () => { await srv.stop(); });

test('a predicting client tracks the authoritative ball during play', async () => {
  const a = await connect(port);
  const b = await connect(port);
  a.send({ t: 'join', v: srv.PROTOCOL });
  b.send({ t: 'join', v: srv.PROTOCOL });
  const start = await a.waitFor(m => m.t === 'start');
  const bot = makeClient(start);
  bot.ws = a;
  const seen = [];
  a.ws.on('message', d => { let m; try { m = JSON.parse(d); } catch (e) { return; } if (m.t === 's') { bot.onSnapshot(m); seen.push(m); } });

  // move the racket around its own half
  bot.send('m', 0, -5);
  for (let i = 0; i < 40; i++) { bot.send('m', Math.sin(i / 4) * 3, -5 + Math.cos(i / 5) * 2); bot.tick(); await sleep(16); }
  bot.send('u');
  for (let i = 0; i < 60; i++) { bot.tick(); await sleep(16); }

  assert.ok(seen.length > 20, 'expected a stream of snapshots, got ' + seen.length);
  assert.ok(bot.snaps > 20, 'expected snapshots to reach the client');
  assert.ok(bot.inputs.length < 5, 'acknowledged inputs should be pruned, left ' + bot.inputs.length);
  assert.ok(bot.maxErr < 3, 'prediction diverged from authority by ' + bot.maxErr.toFixed(2));
  a.close(); b.close();
});