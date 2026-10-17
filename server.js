'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const Sim = require('./sim');

const PORT = process.env.PORT || 8080;
const PROTOCOL = 1;
const MAX_INPUTS_PER_TICK = 8;
const INPUT_QUEUE_MAX = 64;
const COORD_LIMIT = 30;
const BACKPRESSURE_LIMIT = 65536;
const RESTART_COOLDOWN = 1000;

const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]); }
  catch (e) { res.writeHead(400); return res.end(); }
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

const waiting = [];
const rooms = new Map();
let roomSeq = 0;

function newToken() { return 'm' + roomSeq + '_' + Math.random().toString(36).slice(2, 8); }

function makeRoom(a, b) {
  const room = {
    key: 'r' + (++roomSeq),
    token: newToken(),
    players: [a, b],
    ack: [0, 0],
    queues: [[], []],
    S: Sim.create(),
    restartAt: 0,
  };
  rooms.set(room.key, room);
  a.room = room; b.room = room;
  return room;
}

function startMatch(room) {
  room.token = newToken();
  room.S = Sim.create();
  room.ack = [0, 0];
  room.queues = [[], []];
  const msg = { t: 'start', tm: Date.now(), token: room.token, S: Sim.dump(room.S) };
  safeSend(room.players[0], { t: 'room', role: 'p1' });
  safeSend(room.players[1], { t: 'room', role: 'p2' });
  safeSend(room.players[0], msg);
  safeSend(room.players[1], msg);
}

function teardownRoom(room) {
  rooms.delete(room.key);
  room.players.forEach(ws => { if (ws && ws.room === room) ws.room = null; });
  const alive = room.players.filter(ws => ws && ws.readyState === 1);
  alive.forEach(ws => safeSend(ws, { t: 'opp_left' }));
}

function tryPair() {
  while (waiting.length >= 2) {
    const a = waiting.shift(), b = waiting.shift();
    if (a.readyState !== 1) { if (b.readyState === 1) waiting.unshift(b); continue; }
    if (b.readyState !== 1) continue;
    const room = makeRoom(a, b);
    startMatch(room);
  }
}

let last = process.hrtime.bigint();
let acc = 0;
const intervals = [];
intervals.push(setInterval(() => {
  const now = process.hrtime.bigint();
  acc += Math.min(Number(now - last) / 1e6, 50) / 1000;
  last = now;
  while (acc >= Sim.FIXED) {
    acc -= Sim.FIXED;
    tickRooms();
  }
}, 3));

function tickRooms() {
  for (const room of rooms.values()) {
    const inputs = [];
    for (let i = 0; i < 2; i++) {
      const q = room.queues[i];
      let n = 0;
      while (q.length && n < MAX_INPUTS_PER_TICK) {
        const e = q.shift();
        inputs.push({ p: i + 1, seq: e.seq, k: e.k, x: e.x, z: e.z });
        room.ack[i] = e.seq;
        n++;
      }
    }
    const events = Sim.step(room.S, inputs);
    if (events.length) {
      broadcast(room, { t: 'e', tick: room.S.tick, evs: events });
    }
    const snap = Sim.snapshot(room.S);
    broadcast(room, { t: 's', tm: Date.now(), a: [room.ack[0], room.ack[1]], ...snap });
  }
}

function broadcast(room, msg, skippable) {
  const s = JSON.stringify(msg);
  for (const ws of room.players) {
    if (!ws || ws.readyState !== 1) continue;
    if (skippable && ws.bufferedAmount > BACKPRESSURE_LIMIT) continue;
    try { ws.send(s); } catch (e) { /* socket closing */ }
  }
}

function safeSend(ws, msg) {
  if (!ws || ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(msg)); } catch (e) { /* ignore */ }
}

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', data => {
    let m;
    try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'join') {
      if (ws.room || waiting.includes(ws)) return;
      if (m.v !== PROTOCOL) { safeSend(ws, { t: 'ver', v: PROTOCOL }); return; }
      waiting.push(ws);
      tryPair();
      return;
    }

    const room = ws.room;
    if (!room) return;
    const i = room.players.indexOf(ws);
    if (i < 0) return;
    switch (m.t) {
      case 'i': {
        if (m.token !== room.token) return;
        const seq = m.seq;
        if (!Number.isInteger(seq) || seq <= room.ack[i] || seq > room.ack[i] + 10000) return;
        if (m.k !== 'm' && m.k !== 'u') return;
        let x = 0, z = 0;
        if (m.k === 'm') {
          x = +m.x; z = +m.z;
          if (!Number.isFinite(x) || !Number.isFinite(z) ||
              Math.abs(x) > COORD_LIMIT || Math.abs(z) > COORD_LIMIT) return;
        }
        const q = room.queues[i];
        if (q.length >= INPUT_QUEUE_MAX) return;
        q.push({ seq, k: m.k, x, z });
        break;
      }
      case 'ping':
        safeSend(ws, { t: 'pong', ts: m.ts, time: Date.now() });
        break;
      case 'again':
        if (Date.now() - room.restartAt < RESTART_COOLDOWN) return;
        room.restartAt = Date.now();
        startMatch(room);
        break;
    }
  });

  ws.on('close', () => {
    const wi = waiting.indexOf(ws);
    if (wi >= 0) waiting.splice(wi, 1);
    const room = ws.room;
    if (room) teardownRoom(room);
  });
  ws.on('error', () => { /* close handler follows */ });
});

intervals.push(setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000));

function start(port = PORT) {
  return new Promise(resolve => server.listen(port, () => resolve(server.address().port)));
}
function stop() {
  intervals.forEach(clearInterval);
  intervals.length = 0;
  for (const ws of wss.clients) { try { ws.terminate(); } catch (e) { /* ignore */ } }
  return new Promise(resolve => wss.close(() => server.close(() => resolve())));
}
if (require.main === module) {
  start().then(p => console.log(`Ping Pong server on http://0.0.0.0:${p}`));
}
module.exports = { start, stop, PROTOCOL };
