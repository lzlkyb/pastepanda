const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function runtime() {
  let now = 0, next = 0;
  const frames = new Map(), events = {};
  const reduced = { matches: false, addEventListener: (_, fn) => { events.reduce = fn; } };
  const document = { hidden: false, addEventListener: (name, fn) => { events[name] = fn; } };
  const context = { window: {}, document, matchMedia: () => reduced, performance: { now: () => now },
    requestAnimationFrame: fn => { frames.set(++next, fn); return next; },
    cancelAnimationFrame: id => frames.delete(id),
  };
  vm.runInNewContext(fs.readFileSync(`${__dirname}/motion.js`, 'utf8'), context);
  const advance = ms => {
    now += ms;
    const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(now));
  };
  return { ...context.window.PandaMotion, advance, events, reduced, document, frames };
}

test('retargeting preserves position and velocity', () => {
  const r = runtime(), spring = r.spring(0, () => {});
  spring.move(200); r.advance(100);
  const before = spring.read(); spring.move(-100);
  const after = spring.read();
  assert.equal(after.position, before.position);
  assert.equal(after.velocity, before.velocity);
  assert.ok(before.velocity > 0);
});
test('release transfers gesture velocity to the spring', () => {
  const r = runtime(), spring = r.spring(40, () => {});
  spring.move(300, 900);
  assert.equal(spring.read().velocity, 900);
  r.advance(16); assert.ok(spring.read().position > 40);
});
test('reopening cancels stale closing completion and leaves no frames', () => {
  const r = runtime(), spring = r.spring(0, () => {});
  let closed = 0, opened = 0;
  spring.move(400, undefined, () => closed++); r.advance(100);
  spring.move(0, undefined, () => opened++);
  for (let i = 0; i < 80; i++) r.advance(16);
  assert.equal(closed, 0); assert.equal(opened, 1);
  assert.equal(spring.read().position, 0); assert.equal(r.frames.size, 0);
});
test('reduced motion finishes immediately with correct completion', () => {
  const r = runtime(); r.reduced.matches = true;
  const spring = r.spring(0, () => {}); let completed = false;
  spring.move(100, 900, () => { completed = true; });
  assert.equal(spring.read().position, 100);
  assert.equal(completed, true); assert.equal(r.frames.size, 0);
});
test('hidden document settles all active springs and stops scheduling', () => {
  const r = runtime(), spring = r.spring(0, () => {});
  spring.move(200); r.advance(16);
  r.document.hidden = true; r.events.visibilitychange();
  assert.equal(spring.read().position, 200); assert.equal(r.frames.size, 0);
});
test('refresh rate does not change position at the same elapsed time', () => {
  function at(step) {
    const r = runtime(), spring = r.spring(0, () => {});
    spring.move(200);
    for (let i = 0; i < 240 / step; i++) r.advance(step);
    return spring.read();
  }
  assert.ok(Math.abs(at(16).position - at(8).position) < 1e-8);
  assert.ok(Math.abs(at(16).velocity - at(8).velocity) < 1e-8);
});
