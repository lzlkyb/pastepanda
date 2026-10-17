import { useState } from "react";

/** Single in-flow view: commit the latest target immediately, animate only its arrival.
 * No overlapping virtual lists, exit timer, or first-paint entrance. */
export function useViewTransition<T>(target: T): { shown: T; phase: "in" | "idle" } {
  const [seen, setSeen] = useState({ target, changed: false });
  // Derive the next view during render: effects/timers would leave stale controls
  // clickable, or strand a rapid return in its previous exit phase.
  if (!Object.is(seen.target, target)) setSeen({ target, changed: true });
  return { shown: target, phase: seen.changed ? "in" : "idle" };
}
