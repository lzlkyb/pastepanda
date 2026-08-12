/**
 * cardlist-logic.test.ts — CardList 可提取纯逻辑测试
 * 覆盖 M1 重构目标：useLoadMore 状态机、useOcr 选择逻辑、useImagePreview 状态缓存
 * 这些逻辑当前内嵌在 CardList.tsx 中，测试先行保护后续提取
 */
import { describe, it, expect } from "vitest";

// ============================================================
// OCR 类型（从 CardList.tsx 复制，重构后应从 types/ 导入）
// ============================================================
interface OcrWordInfo { text: string; x: number; y: number; width: number; height: number; }
interface OcrLineInfo { text: string; words: OcrWordInfo[]; }
interface OcrResultData { lines: OcrLineInfo[]; full_text: string; }

// ============================================================
// 提取的纯逻辑函数（重构时从 CardList.tsx 移出）
// ============================================================

/** OCR 单词点击选择逻辑（handleOcrWordClick 的核心） */
function ocrWordSelect(prev: Set<string>, key: string, ctrlKey: boolean): Set<string> {
  const next = new Set(prev);
  if (ctrlKey) {
    if (next.has(key)) next.delete(key);
    else next.add(key);
  } else {
    if (next.has(key) && next.size === 1) {
      next.clear();
    } else {
      next.clear();
      next.add(key);
    }
  }
  return next;
}

/** 获取选中 OCR 单词的文本列表 */
function getSelectedOcrTexts(result: OcrResultData | null, indices: Set<string>): string[] {
  if (!result) return [];
  const texts: string[] = [];
  indices.forEach((key) => {
    const [li, wi] = key.split("-").map(Number);
    const word = result.lines[li]?.words[wi];
    if (word) texts.push(word.text);
  });
  return texts;
}

/** 矩形重叠检测（rubber-band 选择的核心） */
function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
): boolean {
  return !(a.x + a.w < b.x || a.x > b.x + b.w || a.y + a.h < b.y || a.y > b.y + b.h);
}

/** 预览状态缓存淘汰（closePreview 中的逻辑） */
function evictPreviewCache(cache: Record<string, unknown>, max = 50): Record<string, unknown> {
  const keys = Object.keys(cache);
  if (keys.length > max) {
    for (const k of keys.slice(0, keys.length - max)) {
      delete cache[k];
    }
  }
  return cache;
}

/** 加载更多：触底检测 */
function shouldTriggerLoadMore(scrollPos: number, maxScroll: number, threshold = 80): boolean {
  return maxScroll - scrollPos < threshold;
}

/** 加载更多：冷却期检测 */
function isInCooldown(now: number, cooldownUntil: number): boolean {
  return now < cooldownUntil;
}

// ============================================================
// 测试数据
// ============================================================
const makeOcrResult = (): OcrResultData => ({
  lines: [
    { text: "Hello World", words: [
      { text: "Hello", x: 10, y: 10, width: 50, height: 20 },
      { text: "World", x: 70, y: 10, width: 50, height: 20 },
    ]},
    { text: "Foo Bar", words: [
      { text: "Foo", x: 10, y: 40, width: 30, height: 20 },
      { text: "Bar", x: 50, y: 40, width: 30, height: 20 },
    ]},
  ],
  full_text: "Hello World\nFoo Bar",
});

// ============================================================
// OCR 单词选择
// ============================================================
describe("ocrWordSelect", () => {
  it("普通点击：选中单词", () => {
    const result = ocrWordSelect(new Set(), "0-0", false);
    expect(result.has("0-0")).toBe(true);
    expect(result.size).toBe(1);
  });

  it("普通点击已选中的唯一单词：取消选择", () => {
    const result = ocrWordSelect(new Set(["0-0"]), "0-0", false);
    expect(result.size).toBe(0);
  });

  it("普通点击新单词：替换选择", () => {
    const result = ocrWordSelect(new Set(["0-0"]), "1-1", false);
    expect(result.has("0-0")).toBe(false);
    expect(result.has("1-1")).toBe(true);
    expect(result.size).toBe(1);
  });

  it("Ctrl+点击：追加选择", () => {
    const result = ocrWordSelect(new Set(["0-0"]), "1-1", true);
    expect(result.has("0-0")).toBe(true);
    expect(result.has("1-1")).toBe(true);
    expect(result.size).toBe(2);
  });

  it("Ctrl+点击已选中：取消该单词", () => {
    const result = ocrWordSelect(new Set(["0-0", "1-1"]), "0-0", true);
    expect(result.has("0-0")).toBe(false);
    expect(result.has("1-1")).toBe(true);
  });

  it("普通点击多选中的某个：只保留新点击的", () => {
    const prev = new Set(["0-0", "0-1", "1-0"]);
    const result = ocrWordSelect(prev, "1-1", false);
    expect(result.size).toBe(1);
    expect(result.has("1-1")).toBe(true);
  });
});

// ============================================================
// OCR 文本提取
// ============================================================
describe("getSelectedOcrTexts", () => {
  const ocr = makeOcrResult();

  it("returns empty for null result", () => {
    expect(getSelectedOcrTexts(null, new Set(["0-0"]))).toEqual([]);
  });

  it("returns empty for empty selection", () => {
    expect(getSelectedOcrTexts(ocr, new Set())).toEqual([]);
  });

  it("extracts single word", () => {
    expect(getSelectedOcrTexts(ocr, new Set(["0-0"]))).toEqual(["Hello"]);
  });

  it("extracts multiple words", () => {
    const texts = getSelectedOcrTexts(ocr, new Set(["0-0", "1-1"]));
    expect(texts).toContain("Hello");
    expect(texts).toContain("Bar");
  });

  it("skips invalid indices gracefully", () => {
    const texts = getSelectedOcrTexts(ocr, new Set(["5-5", "0-0"]));
    expect(texts).toEqual(["Hello"]);
  });
});

// ============================================================
// 矩形重叠检测
// ============================================================
describe("rectsOverlap", () => {
  it("overlapping rects return true", () => {
    expect(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
  });

  it("non-overlapping rects return false", () => {
    expect(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 5, h: 5 })).toBe(false);
  });

  it("touching edges count as overlapping (strict < comparison)", () => {
    // 实现使用 strict <：a.x+a.w < b.x → 10 < 10 = false → 不分离 → 重叠
    expect(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 5, h: 5 })).toBe(true);
  });

  it("contained rect overlaps", () => {
    expect(rectsOverlap({ x: 0, y: 0, w: 100, h: 100 }, { x: 10, y: 10, w: 5, h: 5 })).toBe(true);
  });

  it("zero-size rect inside another counts as overlapping (strict <)", () => {
    // 5+0 < 0 → false, 0+10 < 5 → false → 无分离条件满足 → 重叠
    expect(rectsOverlap({ x: 5, y: 5, w: 0, h: 0 }, { x: 0, y: 0, w: 10, h: 10 })).toBe(true);
  });
});

// ============================================================
// 预览状态缓存淘汰
// ============================================================
describe("evictPreviewCache", () => {
  it("does nothing under limit", () => {
    const cache: Record<string, unknown> = { a: 1, b: 2 };
    evictPreviewCache(cache, 50);
    expect(Object.keys(cache)).toHaveLength(2);
  });

  it("evicts oldest entries over limit", () => {
    const cache: Record<string, unknown> = {};
    for (let i = 0; i < 55; i++) cache[`key${i}`] = i;
    evictPreviewCache(cache, 50);
    expect(Object.keys(cache)).toHaveLength(50);
    // 最旧的 5 个被淘汰
    expect(cache["key0"]).toBeUndefined();
    expect(cache["key4"]).toBeUndefined();
    expect(cache["key5"]).toBe(5);
  });

  it("exactly at limit does not evict", () => {
    const cache: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) cache[`k${i}`] = i;
    evictPreviewCache(cache, 50);
    expect(Object.keys(cache)).toHaveLength(50);
  });
});

// ============================================================
// 加载更多：触底检测
// ============================================================
describe("shouldTriggerLoadMore", () => {
  it("triggers when near bottom", () => {
    expect(shouldTriggerLoadMore(950, 1000, 80)).toBe(true);
  });

  it("does not trigger when far from bottom", () => {
    expect(shouldTriggerLoadMore(500, 1000, 80)).toBe(false);
  });

  it("triggers at exact threshold", () => {
    // maxScroll - scrollPos = 80, threshold = 80 → 80 < 80 is false
    expect(shouldTriggerLoadMore(920, 1000, 80)).toBe(false);
    expect(shouldTriggerLoadMore(921, 1000, 80)).toBe(true);
  });

  it("triggers when content shorter than viewport (maxScroll=0)", () => {
    expect(shouldTriggerLoadMore(0, 0, 80)).toBe(true);
  });
});

// ============================================================
// 加载更多：冷却期
// ============================================================
describe("isInCooldown", () => {
  it("true when now < cooldownUntil", () => {
    expect(isInCooldown(1000, 1500)).toBe(true);
  });

  it("false when now >= cooldownUntil", () => {
    expect(isInCooldown(1500, 1500)).toBe(false);
    expect(isInCooldown(2000, 1500)).toBe(false);
  });
});

// ============================================================
// 加载更多：状态机完整流程模拟
// ============================================================
describe("load-more state machine", () => {
  it("lock prevents concurrent loads", () => {
    let loadingLock = false;
    const hasMore = true;
    let loadingMore = false;

    function tryLoad(): boolean {
      if (loadingLock) return false;
      if (!hasMore || loadingMore) return false;
      loadingLock = true;
      loadingMore = true;
      return true;
    }

    expect(tryLoad()).toBe(true);
    expect(tryLoad()).toBe(false); // 锁住

    // 模拟完成
    loadingLock = false;
    loadingMore = false;
    expect(tryLoad()).toBe(true);
  });

  it("hasMore=false stops all loads", () => {
    const hasMore = false;
    let loadingLock = false;
    let loadingMore = false;

    function tryLoad(): boolean {
      if (loadingLock || !hasMore || loadingMore) return false;
      loadingLock = true;
      loadingMore = true;
      return true;
    }

    expect(tryLoad()).toBe(false);
  });

  it("cooldown blocks trigger even when at bottom", () => {
    const now = 1000;
    const cooldownUntil = 1500;
    const atBottom = shouldTriggerLoadMore(990, 1000, 80);
    const cooled = isInCooldown(now, cooldownUntil);
    expect(atBottom).toBe(true);
    expect(cooled).toBe(true);
    // 综合判断：不触发
    expect(atBottom && !cooled).toBe(false);
  });
});

// ============================================================
// OCR rubber-band 选择集成
// ============================================================
describe("OCR rubber-band selection integration", () => {
  const ocr = makeOcrResult();

  it("selects words within selection rect", () => {
    // 选择框覆盖第一行 (y:10-30, x:10-120)
    const selRect = { x: 5, y: 5, w: 120, h: 30 };
    const selected = new Set<string>();

    ocr.lines.forEach((line, li) => {
      line.words.forEach((word, wi) => {
        const wordRect = { x: word.x, y: word.y, w: word.width, h: word.height };
        if (rectsOverlap(selRect, wordRect)) {
          selected.add(`${li}-${wi}`);
        }
      });
    });

    expect(selected.has("0-0")).toBe(true); // Hello
    expect(selected.has("0-1")).toBe(true); // World
    expect(selected.has("1-0")).toBe(false); // Foo (y=40, outside)
    expect(selected.has("1-1")).toBe(false); // Bar
  });

  it("selects all words with full-image rect", () => {
    const selRect = { x: 0, y: 0, w: 200, h: 200 };
    const selected = new Set<string>();

    ocr.lines.forEach((line, li) => {
      line.words.forEach((word, wi) => {
        if (rectsOverlap(selRect, { x: word.x, y: word.y, w: word.width, h: word.height })) {
          selected.add(`${li}-${wi}`);
        }
      });
    });

    expect(selected.size).toBe(4);
  });

  it("empty selection rect selects nothing", () => {
    const selRect = { x: 500, y: 500, w: 0, h: 0 };
    const selected = new Set<string>();

    ocr.lines.forEach((line, li) => {
      line.words.forEach((word, wi) => {
        if (rectsOverlap(selRect, { x: word.x, y: word.y, w: word.width, h: word.height })) {
          selected.add(`${li}-${wi}`);
        }
      });
    });

    expect(selected.size).toBe(0);
  });
});
