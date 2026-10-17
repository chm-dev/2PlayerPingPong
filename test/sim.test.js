'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Sim = require('../sim');

function script() {
  const s = {};
  s[1] = [{ p: 1, k: 'm', x: 0, z: -5 }];
  for (let t = 2; t <= 12; t++) s[t] = [{ p: 1, k: 'm', x: (t - 2) * 0.4, z: -5 + (t - 2) * 0.5 }];
  s[13] = [{ p: 1, k: 'u' }];
  return s;
}
function run(ticks, sc) {
  const S = Sim.create();
  const states = [];
  for (let t = 1; t <= ticks; t++) {
    Sim.step(S, (sc && sc[t]) || []);
    states.push(Sim.dump(S));
  }
  return { S, states };
}

test('initial state', () => {
  const S = Sim.create();
  assert.equal(S.phase, 'playing');
  assert.deepEqual(S.scores, [0, 0, 0]);
  assert.deepEqual(S.ball.pos, [0, 2, -8]);
  assert.equal(S.tick, 0);
  assert.equal(S.server, 1);
  assert.equal(S.ball.serving, true);
});

test('deterministic replay of the same script', () => {
  const a = run(120, script());
  const b = run(120, script());
  for (let i = 0; i < a.states.length; i++) assert.deepEqual(a.states[i], b.states[i], 'tick ' + (i + 1));
});

test('dump/load round-trip resumes identically', () => {
  const full = run(120, script());
  const S = Sim.load(full.states[59]);
  assert.deepEqual(Sim.dump(S), full.states[59]);
  for (let t = 61; t <= 120; t++) {
    Sim.step(S, script()[t] || []);
    assert.deepEqual(Sim.dump(S), full.states[t - 1], 'tick ' + t);
  }
});

test('wire snapshot round-trip stays close', () => {
  const full = run(60, script());
  const wire = Sim.snapshot(full.S);
  const C = Sim.create();
  Sim.applySnapshot(C, wire);
  assert.equal(C.tick, full.S.tick);
  for (let i = 0; i < 30; i++) { Sim.step(C, []); Sim.step(full.S, []); }
  const b = full.S.ball.pos, c = C.ball.pos;
  const err = Math.sqrt((b[0]-c[0])**2 + (b[1]-c[1])**2 + (b[2]-c[2])**2);
  assert.ok(err < 1.5, 'divergence from 2-decimal snapshots should stay small, got ' + err);
});

test('applySnapshot preserves flight state and step advances tw', () => {
  const full = run(20, script());
  const wire = Sim.snapshot(full.S);
  const C = Sim.create();
  Sim.applySnapshot(C, wire);
  assert.equal(C.flightTicks, full.S.flightTicks);
  const beforeTw = C.ball.tw ? C.ball.tw.tick : null;
  Sim.step(C, []);
  // flightTicks unchanged by a plain step
  assert.equal(C.flightTicks, full.S.flightTicks);
});

test('a point scores, sets serveTicks, and serves rotate every 2 points', () => {
  const S = Sim.create();
  // force a flight that completes this tick and scores for p1
  S.ball.hitter = 1;
  S.ball.last = 2;
  S.ball.tw = { tick: 0, ticks: 1 };
  S.ball.bez = { p0:[0,0,0], p1:[0,0,0], p2:[0,0,0], p3:[0,0,0] };
  S.ball.pos = [0,10,0]; S.ball.old = [0,10,0];
  const evs = Sim.step(S, []);
  assert.equal(S.scores[1], 1);
  assert.equal(S.serveTicks, 49);
  assert.ok(evs.some(e => e.ev === 'point' && e.p === 1));
  assert.equal(S.server, 1); // one point total -> no rotation
});

test('first to 7 ends the match', () => {
  const S = Sim.create();
  S.scores[1] = 6;
  S.ball.hitter = 1;
  S.ball.last = 2;
  S.ball.tw = { tick: 0, ticks: 1 };
  S.ball.bez = { p0:[0,0,0], p1:[0,0,0], p2:[0,0,0], p3:[0,0,0] };
  S.ball.pos = [0,10,0]; S.ball.old = [0,10,0];
  let winEv = null;
  for (const e of Sim.step(S, [])) if (e.ev === 'win') winEv = e;
  assert.equal(S.scores[1], 7);
  assert.equal(S.phase, 'over');
  assert.equal(S.winner, 1);
  assert.ok(winEv && winEv.p === 1);
});

test('pointer-up clears swipe params', () => {
  const S = Sim.create();
  Sim.step(S, [{ p: 1, k: 'm', x: 2, z: -6 }]);
  assert.notEqual(S.rackets[1].params.spin + S.rackets[1].params.dir + S.rackets[1].params.pot, 0);
  Sim.step(S, [{ p: 1, k: 'u' }]);
  assert.equal(S.rackets[1].params.spin, 0);
  assert.equal(S.rackets[1].params.dir, 0);
  assert.equal(S.rackets[1].params.pot, 0);
});

test('u input with no coords is accepted', () => {
  const S = Sim.create();
  assert.doesNotThrow(() => Sim.step(S, [{ p: 1, k: 'u' }]));
});

test('determinism hygiene: no Math.hypot / Math.random in the sim', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'sim.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.ok(!/Math\.hypot\(/.test(code), 'sim.js must not use Math.hypot');
  assert.ok(!/Math\.random\(/.test(code), 'sim.js must not use Math.random');
});

test('serve places ball at SERVE[server]', () => {
  // countdown a fresh serve
  const S = Sim.create();
  S.serveTicks = 1;
  Sim.step(S, []);
  // serveTicks hit 0 -> servizio() called; ball at SERVE[server]
  assert.deepEqual(S.ball.pos, Sim.SERVE[S.server].slice());
  assert.equal(S.ball.serving, true);
  assert.equal(S.ball.hitter, 0);
  assert.equal(S.ball.last, 2);
});