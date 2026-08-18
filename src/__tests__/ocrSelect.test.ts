import { describe, it, expect } from "vitest";
import {
  pointInAnyWord,
  shouldStartOcrSelect,
  selectSpan,
  selectLine,
  type CharRect,
} from "@/lib/screenshot/ocrSelect";
import type { Annotation } from "@/lib/screenshot/types";

const rects: CharRect[] = [
  { key: "0-0", x: 0, y: 0, w: 20, h: 10 },
  { key: "0-1", x: 24, y: 0, w: 20, h: 10 },
  { key: "1-0", x: 0, y: 20, w: 20, h: 10 }, // 隐私行（被马赛克盖住）
];

// 模拟「整行盖马赛克」：一个覆盖第二行的遮罩标注
const annotations: Annotation[] = [
  {
    id: 1,
    type: "mosaic",
    color: "#000",
    width: 0,
    x: 0,
    y: 20,
    x2: 40,
    y2: 30,
  } as Annotation,
];

describe("pointInAnyWord", () => {
  it("落字内返回该字 key", () => {
    expect(pointInAnyWord(10, 5, rects, [])).toBe("0-0");
    expect(pointInAnyWord(34, 5, rects, [])).toBe("0-1");
  });

  it("落在字间空白返回 null", () => {
    // x=22 在两字之间（0-0 占 0~20，0-1 占 24~44）
    expect(pointInAnyWord(22, 5, rects, [])).toBeNull();
  });

  it("落在完全空白区返回 null", () => {
    expect(pointInAnyWord(100, 100, rects, [])).toBeNull();
  });

  it("隐私行（被马赛克盖住）整字排除", () => {
    expect(pointInAnyWord(10, 25, rects, annotations)).toBeNull();
    // 非隐私行仍正常命中
    expect(pointInAnyWord(10, 5, rects, annotations)).toBe("0-0");
  });
});

describe("shouldStartOcrSelect", () => {
  it("smart 模式：落字内即选字", () => {
    expect(shouldStartOcrSelect("0-0", "smart", false)).toBe(true);
  });

  it("smart 模式：空白区不起手", () => {
    expect(shouldStartOcrSelect(null, "smart", false)).toBe(false);
  });

  it("modifier 模式：需 Ctrl/⌘ 才选字（裸拖不选）", () => {
    expect(shouldStartOcrSelect("0-0", "modifier", false)).toBe(false);
    expect(shouldStartOcrSelect("0-0", "modifier", true)).toBe(true);
    expect(shouldStartOcrSelect(null, "modifier", true)).toBe(false);
  });
});

// ===== selectSpan：跨行连续选字（阅读序 L 形，桥接换行）=====
// 两行文字（每行 4 / 3 字，字宽 20、间隔 4，行高 10、行距 10）
const spanRects: CharRect[] = [
  { key: "0-0", x: 0, y: 0, w: 20, h: 10 },
  { key: "0-1", x: 24, y: 0, w: 20, h: 10 },
  { key: "0-2", x: 48, y: 0, w: 20, h: 10 },
  { key: "0-3", x: 72, y: 0, w: 20, h: 10 },
  { key: "1-0", x: 0, y: 20, w: 20, h: 10 },
  { key: "1-1", x: 24, y: 20, w: 20, h: 10 },
  { key: "1-2", x: 48, y: 20, w: 20, h: 10 },
];

describe("selectSpan", () => {
  it("单行拖选：选起手字到终点字之间的连续字", () => {
    // 起手 0-0，终点落在 0-3 上
    expect([...selectSpan(spanRects, "0-0", 82, 5, [])!].sort()).toEqual(["0-0", "0-1", "0-2", "0-3"]);
  });

  it("跨行向下 L 形：起手行选到行尾，终点行选到行首", () => {
    // 起手 0-1，终点落在第二行 1-0 上
    const sel = selectSpan(spanRects, "0-1", 5, 25, [])!;
    expect([...sel].sort()).toEqual(["0-1", "0-2", "0-3", "1-0"]);
  });

  it("行带桥接：光标落在行间空白仍跨行连续选字（不断）", () => {
    // 起点 0-0，终点 x=5、y=17 在行间空白（第一行底 10 / 第二行顶 20 之间，
    // 偏向第二行）→ 桥接到最近行第二行 1-0，不应因换行中断
    const sel = selectSpan(spanRects, "0-0", 5, 17, [])!;
    expect([...sel].sort()).toEqual(["0-0", "0-1", "0-2", "0-3", "1-0"]);
  });

  it("明显离文字（横向超出整段列范围）返回 null → 调用方转标注", () => {
    expect(selectSpan(spanRects, "0-0", 200, 200, [])).toBeNull();
  });

  it("明显离文字（垂直远离所有行）返回 null", () => {
    expect(selectSpan(spanRects, "0-0", 34, 200, [])).toBeNull();
  });

  it("跨行向上 L 形：起手行选到行首，终点行选到行尾", () => {
    // 起手第二行 1-2，终点落在第一行 0-0（行首）上：
    // 起手行（下）选行首→起手字（1-0/1-1/1-2），终点行（上）选焦点→行尾（整行 0-0..0-3）
    const sel = selectSpan(spanRects, "1-2", 5, 5, [])!;
    expect([...sel].sort()).toEqual(["0-0", "0-1", "0-2", "0-3", "1-0", "1-1", "1-2"]);
  });
});

// ===== selectSpan 隐私行排除 =====
const maskedSpanRects: CharRect[] = [
  { key: "0-0", x: 0, y: 0, w: 20, h: 10 },
  { key: "0-1", x: 24, y: 0, w: 20, h: 10 }, // 被马赛克盖住
  { key: "0-2", x: 48, y: 0, w: 20, h: 10 },
  { key: "0-3", x: 72, y: 0, w: 20, h: 10 },
  { key: "1-0", x: 0, y: 20, w: 20, h: 10 },
  { key: "1-1", x: 24, y: 20, w: 20, h: 10 },
  { key: "1-2", x: 48, y: 20, w: 20, h: 10 },
];
const maskAnno: Annotation[] = [
  { id: 1, type: "mosaic", color: "#000", width: 0, x: 24, y: 0, x2: 44, y2: 10 } as Annotation,
];

describe("selectSpan 隐私行", () => {
  it("被马赛克盖住的字不进入选区", () => {
    const sel = selectSpan(maskedSpanRects, "0-0", 5, 25, maskAnno)!;
    expect(sel.has("0-1")).toBe(false);
    expect([...sel].sort()).toEqual(["0-0", "0-2", "0-3", "1-0"]);
  });
});

/**
 * 单击文字 = 选中整行（不再静默复制单个字）。
 *
 * 旧行为是「单击就把一个字写进剪贴板」，两头都不对：默认就是矩形工具，用户很可能
 * 只是想在文字上起手画框或随手点一下，却把剪贴板里原有的东西覆盖掉了；就算真想取字，
 * 一个字也几乎没用。现在单击选中整行、等用户点复制条才写剪贴板。
 */
describe("selectLine", () => {
  const three: CharRect[] = [
    { key: "0-0", x: 0, y: 0, w: 20, h: 10 },
    { key: "0-1", x: 24, y: 0, w: 20, h: 10 },
    { key: "0-2", x: 48, y: 0, w: 20, h: 10 },
    { key: "1-0", x: 0, y: 20, w: 20, h: 10 },
  ];

  it("选中该字所在行的全部字，不含其它行", () => {
    expect(selectLine(three, "0-1", [])).toEqual(new Set(["0-0", "0-1", "0-2"]));
  });

  it("点第二行只选第二行", () => {
    expect(selectLine(three, "1-0", [])).toEqual(new Set(["1-0"]));
  });

  it("隐私行被遮时不会选出被遮的字", () => {
    // annotations 盖住第二行（y 20~30）
    expect(selectLine(three, "1-0", annotations).has("1-0")).toBe(false);
  });

  it("行不存在时返回空集（不兜底把起手字加回去）", () => {
    // 兜底成 new Set([key]) 的话，隐私行那条用例就会把被马赛克盖住的字选回来
    expect(selectLine(three, "9-9", [])).toEqual(new Set());
  });
});

/**
 * 行几何按引用缓存（buildLines）。缓存键是 rects/annotations 的**引用**，
 * 所以换了数组内容必须立刻反映出来——否则拖选期间改了标注会读到过期几何。
 */
describe("行几何缓存不会返回过期结果", () => {
  it("换一份 rects 后命中结果随之改变", () => {
    const a: CharRect[] = [{ key: "0-0", x: 0, y: 0, w: 20, h: 10 }];
    const b: CharRect[] = [{ key: "0-0", x: 100, y: 100, w: 20, h: 10 }];
    expect(pointInAnyWord(10, 5, a, [])).toBe("0-0");
    expect(pointInAnyWord(10, 5, b, [])).toBeNull();
    expect(pointInAnyWord(110, 105, b, [])).toBe("0-0");
    // 再切回来仍然正确（不是“最后一次赢”）
    expect(pointInAnyWord(10, 5, a, [])).toBe("0-0");
  });

  it("同一份 rects 换 annotations 后遮罩立即生效", () => {
    const r: CharRect[] = [{ key: "0-0", x: 0, y: 20, w: 20, h: 10 }];
    expect(pointInAnyWord(10, 25, r, [])).toBe("0-0");
    expect(pointInAnyWord(10, 25, r, annotations)).toBeNull();
  });
});
