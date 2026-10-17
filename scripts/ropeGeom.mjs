// 稿1 绳带几何的独立复算（与 mockup 内公式一致），用来核对设计稿 §3 表读数。
const SIDE = 16, GAP = 12, MAX_W = 240, MAX_H = 180, AR = 3 / 2;
const cardW = (n, sw) => Math.min(MAX_W, Math.floor((sw - 2 * SIDE - (n - 1) * GAP) / n));
const cardH = (w) => Math.min(MAX_H, Math.round(w / AR));
const rows = [];
for (const sw of [1920, 1440, 1366, 1280]) {
  for (let n = 2; n <= 8; n++) {
    const w = cardW(n, sw), h = cardH(w);
    const total = n * w + (n - 1) * GAP;
    const usable = sw - 2 * SIDE;
    const band = SIDE + h + SIDE;
    // 岛（208×32，顶右留边 16）与第 i 张（0 基）的水平重叠起点
    const islandLeft = sw - SIDE - 208;
    const firstHit = Array.from({ length: n }, (_, i) => SIDE + i * (w + GAP))
      .findIndex((x) => x + w > islandLeft);
    rows.push({ sw, n, w, h, total, usable, over: total > usable, band, firstHit: firstHit >= 0 ? firstHit + 1 : 0 });
  }
}
for (const r of rows.filter((x) => x.sw === 1440 || x.sw === 1280)) {
  console.log(`sw=${r.sw} n=${r.n} card=${r.w}x${r.h} 绳带总宽=${r.total}/${r.usable} ${r.over ? "越屏" : "不越"} 带高=${r.band} 岛冲突=第${r.firstHit}张起`);
}
console.log("\n关键对照：");
console.log("1440 n=5 card=", cardW(5, 1440), " n=6 card=", cardW(6, 1440), " n=8 card=", cardW(8, 1440));
console.log("1280 n=5 card=", cardW(5, 1280), " n=6 card=", cardW(6, 1280));
console.log("240 上限需要屏宽至少", (MAX_W * 5 + 4 * GAP + 2 * SIDE), "px (n=5) /", (MAX_W * 8 + 7 * GAP + 2 * SIDE), "px (n=8)");
console.log("满宽 240 时卡片高 =", cardH(240), "→ 带高 =", SIDE + cardH(240) + SIDE);
