export type MobileSpring = ReturnType<typeof createMobileSpring>;

/** U2 displacement spring. Sampling elapsed time preserves the path across refresh rates. */
export function createMobileSpring(initial: number, draw: (value: number) => void) {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const frequency = Math.sqrt(130 - 64); // m=1, k=130, c=16, shared project parameters.
  let position = initial,
    velocity = 0,
    target = initial;
  let origin = initial,
    speed = 0,
    started = 0,
    frame: number | null = null;
  let completion: (() => void) | undefined;
  let bounds: { min: number; max: number } | undefined;
  function read(now = performance.now()) {
    if (frame !== null) {
      const seconds = (now - started) / 1000,
        distance = origin - target;
      const b = (speed + 8 * distance) / frequency,
        decay = Math.exp(-8 * seconds);
      const cosine = Math.cos(frequency * seconds),
        sine = Math.sin(frequency * seconds);
      const wave = distance * cosine + b * sine;
      position = target + decay * wave;
      velocity = decay * (-8 * wave + frequency * (-distance * sine + b * cosine));
      // Pagers can stop at their destination without changing other components' natural spring overshoot.
      if (bounds && (position < bounds.min || position > bounds.max)) {
        position = Math.max(bounds.min, Math.min(bounds.max, position));
        velocity = 0;
      }
    }
    return { position, velocity };
  }
  function stop() {
    read();
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    completion = undefined;
    draw(position);
    return { position, velocity };
  }
  function finish() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    position = target;
    velocity = 0;
    draw(position);
    const done = completion;
    completion = undefined;
    done?.();
  }
  function tick(now: number) {
    read(now);
    draw(position);
    if ((Math.abs(position - target) < 0.1 && Math.abs(velocity) < 1) || now - started >= 1200) finish();
    else frame = requestAnimationFrame(tick);
  }
  function move(next: number, initialVelocity?: number, done?: () => void, limits?: { min: number; max: number }) {
    stop();
    bounds = limits;
    target = next;
    origin = position;
    speed = initialVelocity ?? velocity;
    started = performance.now();
    completion = done;
    if (reduced.matches || document.hidden) {
      finish();
      return;
    }
    frame = requestAnimationFrame(tick);
  }
  function set(next: number) {
    stop();
    position = target = next;
    velocity = 0;
    draw(position);
  }
  const hidden = () => {
    if (document.hidden && frame !== null) finish();
  };
  const preference = () => {
    if (reduced.matches && frame !== null) finish();
  };
  document.addEventListener("visibilitychange", hidden);
  reduced.addEventListener("change", preference);
  draw(initial);
  return {
    read,
    stop,
    move,
    set,
    dispose: () => {
      stop();
      document.removeEventListener("visibilitychange", hidden);
      reduced.removeEventListener("change", preference);
    },
  };
}
