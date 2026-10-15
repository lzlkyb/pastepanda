// Preview policy: freeze the contact and grip offset for the lifetime of one drag.
export function beginDrag(rect, point, contactY) {
  return { rect: { ...rect }, grip: { x: point.x - rect.x, y: point.y - rect.y }, contactY, held: true, returned: false };
}

export function moveDrag(drag, point) {
  if (!drag.held) return drag;
  drag.rect.x = point.x - drag.grip.x;
  drag.rect.y = point.y - drag.grip.y;
  drag.returned = Math.abs(drag.rect.y - drag.contactY) <= 24;
  return drag;
}

export function endDrag(drag, cancelled = false) {
  drag.held = false;
  return cancelled || drag.returned ? 'return' : 'pin';
}

export function originalPinRect(rect, image, scale = 1) {
  // Window coordinates are logical; image dimensions are physical pixels.
  return { ...rect, width: image.width / scale, height: image.height / scale };
}

export function resolveDropRect(rect, image, point, { held = false, target = 'desktop', scale = 1 } = {}) {
  if (held) return { ...rect };
  if (target === 'application') return null;
  const original = originalPinRect(rect, image, scale);
  return { ...original, x: point.x - original.width / 2, y: point.y - original.height / 2 };
}

export function regrabPreviewRect(original, start, point, size) {
  if (Math.hypot(point.x - start.x, point.y - start.y) < 4) return { ...original };
  return { x: point.x - size.width / 2, y: point.y - size.height / 2, ...size };
}

export function snapToRope(point, points, active = false) {
  if (points.length < 2) return null;
  const left = points[0].x, right = points.at(-1).x;
  const pad = active ? 48 : 24;
  if (point.x < left - pad || point.x > right + pad) return null;
  const x = Math.max(left, Math.min(right, point.x));
  const i = Math.max(1, points.findIndex(p => p.x >= x));
  const a = points[i - 1], b = points[i];
  const y = a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x);
  // Hysteresis keeps the marker stable when the pointer wobbles near its edge.
  return Math.abs(point.y - y) <= (active ? 96 : 64) ? { x, y } : null;
}
