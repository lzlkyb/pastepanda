export function createOriginalCache(read, budget = 96 * 1024 * 1024) {
  const cached = new Map(), pending = new Map();
  const waiting = [];
  let bytes = 0, active = true, running = 0;
  const keyOf = p => JSON.stringify([p.id, p.path, p.width, p.height]);
  const release = () => { const next = waiting.shift(); if (next) next(); else running--; };
  return {
    async load(photo, needed = () => true) {
      const key = keyOf(photo), hit = cached.get(key);
      if (hit) { cached.delete(key); cached.set(key, hit); return hit.url; }
      if (pending.has(key)) return pending.get(key);
      const perform = async () => {
        if (running >= 2) await new Promise(resolve => waiting.push(resolve));
        else running++;
        if (!active || !needed()) { release(); throw new Error('预览已关闭'); }
        try {
          const url = await read(photo);
          const image = new Image(); image.src = url;
          if (typeof image.decode === 'function') await image.decode();
          return url;
        } finally { release(); }
      };
      const request = perform().then(url => {
        const cost = photo.width * photo.height * 4 + url.length * 2;
        if (active && cost <= budget) {
          while (cached.size >= 2 || bytes + cost > budget) {
            const oldest = cached.keys().next().value, entry = cached.get(oldest);
            if (!entry) break;
            bytes -= entry.cost; cached.delete(oldest);
          }
          cached.set(key, {url, cost}); bytes += cost;
        }
        return url;
      }).finally(() => pending.delete(key));
      pending.set(key, request);
      return request;
    },
    clear() { active = false; cached.clear(); pending.clear(); bytes = 0; },
    invalidate(photo) { const key = keyOf(photo), old = cached.get(key); if (old) { bytes -= old.cost; cached.delete(key); } },
  };
}
