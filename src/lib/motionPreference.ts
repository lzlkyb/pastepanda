/** Window-local preference. Capture windows can share the policy without loading appStore. */
let enabled = true;
const listeners = new Set<() => void>();
export const motionPreference = {
  getSnapshot: () => enabled,
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
};

export function setMotionPreference(value: boolean) {
  if (enabled === value) return;
  enabled = value;
  listeners.forEach(listener => listener());
}
