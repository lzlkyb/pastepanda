// One spring for displacement: project U2, m=1, k=130, c=16.
// Sample from elapsed time so refresh rate does not change the trajectory.
(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const active = new Set();
  const frequency = Math.sqrt(130 - 64);
  function sample(position, velocity, target, seconds) {
    const distance = position - target;
    const b = (velocity + 8 * distance) / frequency;
    const decay = Math.exp(-8 * seconds);
    const cosine = Math.cos(frequency * seconds), sine = Math.sin(frequency * seconds);
    const wave = distance * cosine + b * sine;
    return {
      position: target + decay * wave,
      velocity: decay * (-8 * wave + frequency * (-distance * sine + b * cosine)),
    };
  }
  function spring(initial, draw) {
    let position = initial, velocity = 0, target = initial;
    let origin = initial, speed = 0, started = 0, frame = null, completion;
    function read(now = performance.now()) {
      if (frame !== null) {
        const state = sample(origin, speed, target, (now - started) / 1000);
        position = state.position; velocity = state.velocity;
      }
      return { position, velocity };
    }
    function stop() {
      read();
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null; active.delete(finish); completion = undefined;
      draw(position);
      return { position, velocity };
    }
    function finish() {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null; active.delete(finish);
      position = target; velocity = 0; draw(position);
      const done = completion; completion = undefined; done?.();
    }
    function tick(now) {
      read(now); draw(position);
      if ((Math.abs(position - target) < .1 && Math.abs(velocity) < 1) || now - started >= 1200) finish();
      else frame = requestAnimationFrame(tick);
    }
    function move(next, initialVelocity, done) {
      stop(); target = next; origin = position;
      speed = initialVelocity ?? velocity; started = performance.now(); completion = done;
      if (reduced.matches || document.hidden) { finish(); return; }
      active.add(finish); frame = requestAnimationFrame(tick);
    }
    function set(next) { stop(); position = target = next; velocity = 0; draw(position); }
    draw(initial);
    return { move, set, stop, read };
  }
  const settle = () => [...active].forEach(finish => finish());
  document.addEventListener('visibilitychange', () => { if (document.hidden) settle(); });
  reduced.addEventListener('change', () => { if (reduced.matches) settle(); });
  window.PandaMotion = { spring, sample, reduced };
})();
