export const SPRING = Object.freeze({ mass: 1, stiffness: 130, damping: 16 });
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const WIND_TIMING = Object.freeze({ lead: 500, flight: 800, stagger: 60 });
export const defaultAnchors = (width) => ({
  left: { x: 24, y: 32 },
  right: width < 504 ? { x: width - 24, y: 80 } : { x: width - 240, y: 32 },
});

export function constrainAnchors(anchors, side, width, height = 760) {
  const next = structuredClone(anchors),
    point = next[side];
  const span = Math.min(240, Math.max(1, width - 48));
  point.x = clamp(point.x, side === "left" ? 24 : next.left.x + span, side === "left" ? next.right.x - span : Math.max(24, width - 24));
  point.y = clamp(point.y, 32, Math.max(32, height - 280));
  return next;
}
export function moveAnchors(anchors, dx, dy, width, height = 760) {
  // 默认位置可预留空间，用户拖动只受屏幕边界限制，不能把横向位移夹成零。
  dy = clamp(
    dy,
    32 - Math.min(anchors.left.y, anchors.right.y),
    Math.max(32, height - 280) - Math.max(anchors.left.y, anchors.right.y),
  );
  dx = clamp(dx, 24 - anchors.left.x, width - 24 - anchors.right.x);
  return {
    left: { x: anchors.left.x + dx, y: anchors.left.y + dy },
    right: { x: anchors.right.x + dx, y: anchors.right.y + dy },
  };
}
export function canSettle({ enabled, hidden, reduced, dragging, preview }) {
  return enabled && !hidden && !reduced && !dragging && !preview;
}
export function insertAtSlot(items, item, slot, capacity) {
  const remaining = items.filter((current) => current.id !== item.id);
  const visible = remaining.slice(-capacity),
    queued = remaining.slice(0, Math.max(0, remaining.length - capacity));
  if (visible.length === capacity) queued.push(visible.shift());
  visible.splice(clamp(slot, 0, visible.length), 0, item);
  return [...queued, ...visible];
}
export function layout(width, items, anchors = defaultAnchors(width)) {
  const left = anchors.left.x,
    right = anchors.right.x,
    span = right - left;
  const capacity = Math.min(8, Math.max(1, Math.floor((span + 12) / 126)));
  const visible = items.slice(-capacity);
  const imageWidth = Math.min(240, Math.floor((span - 12 * (visible.length - 1)) / Math.max(1, visible.length)) - 18);
  let x = left;
  const cards = visible.map((item) => {
    const iw = Math.max(96, imageWidth),
      ih = clamp(Math.round(iw / Math.max(0.001, item.aspect || 1)), 24, 180);
    const card = { item, x: x + (iw + 18) / 2, iw, ih, width: iw + 18, height: ih + 30 };
    x += card.width + 12;
    return card;
  });
  return { left, right, span, cards, queued: items.length - visible.length, anchors };
}

export function equilibrium(geometry, strength = 1) {
  const { cards, left, span } = geometry;
  const mass = cards.reduce((total, card) => total + (card.item.weight ?? 1), 0);
  const maximum = clamp((9 + mass * 5.8) * strength, 6, 60);
  // A 方案：浅弧承托局部负载。先求有限采样的平衡形状，再归一化，保证端点固定和下垂封顶。
  const raw = Array.from({ length: 65 }, (_, i) => {
    const t = i / 64,
      envelope = 4 * t * (1 - t);
    const local = cards.reduce((total, card) => {
      const center = (card.x - left) / span;
      return total + (card.item.weight ?? 1) * Math.exp(-(((t - center) / 0.2) ** 2));
    }, 0);
    return envelope * (9 + 6 * local);
  });
  const peak = Math.max(...raw);
  return raw.map((value) => (value / peak) * maximum);
}

export function springProgress(seconds) {
  const decay = SPRING.damping / (2 * SPRING.mass);
  const omega = Math.sqrt(SPRING.stiffness / SPRING.mass - decay ** 2);
  return 1 - Math.exp(-decay * seconds) * (Math.cos(omega * seconds) + (decay / omega) * Math.sin(omega * seconds));
}

export function springImpulse(seconds, velocity = 160) {
  const decay = SPRING.damping / (2 * SPRING.mass);
  const omega = Math.sqrt(SPRING.stiffness / SPRING.mass - decay ** 2);
  return (velocity / omega) * Math.exp(-decay * seconds) * Math.sin(omega * seconds);
}

export function sample(curve, t) {
  const position = clamp(t, 0, 1) * (curve.length - 1);
  const index = Math.floor(position),
    next = Math.min(index + 1, curve.length - 1);
  return curve[index] + (curve[next] - curve[index]) * (position - index);
}
export function ropePoint(geometry, curve, t) {
  t = clamp(t, 0, 1);
  return {
    x: geometry.left + geometry.span * t,
    y: geometry.anchors.left.y + (geometry.anchors.right.y - geometry.anchors.left.y) * t + sample(curve, t),
  };
}
export function ropeDrop(geometry, curve, x) {
  const t = clamp((x - geometry.left) / geometry.span, 0, 1);
  return { ...ropePoint(geometry, curve, t), t };
}

export function restoreSnapshot(current, snapshot, capacity) {
  const present = new Set(current.map((item) => item.id));
  const restored = snapshot.filter((item) => !present.has(item.id));
  // 撤销只恢复当次快照；后续新挂照片优先保留，容量不足的旧卡明确留在排队区。
  return { items: [...restored, ...current], queued: Math.max(0, restored.length + current.length - capacity) };
}

export function isDetached(dx, dy, height) {
  return dy > Math.min(60, height * 0.4) || dy < -45 || Math.abs(dx) > 90;
}
