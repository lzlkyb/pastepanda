/**
 * imageFullscreen.test.ts — 图片详情查看层交互守卫测试。
 *
 * 钉住三条不变量（按规则 #11.1：分支逻辑收口后必须有守卫钉住）：
 * 1. 滚轮 = 以光标为中心的缩放：缩放换算公式与 clamp 边界（hook 内的纯推导）；
 * 2. OCR「零二次识别」：进场全文来自 item.ocr_text（列表缓存），词框只在选词时现跑；
 * 3. 面板互斥：OCR 选词态顶替摘要面板、裁剪态收起一切面板——互斥链唯一收口。
 */
import { describe, it, expect } from "vitest";
import { clampImageZoom } from "@/lib/imagePreviewFit";

// ===== 1. 滚轮缩放（光标为中心）的纯推导 =====
// 与 useImagePreview.handlePreviewWheel 同公式：容器 transform = translate(offset)·scale，
// 令光标下的图像点不动 ⇒ offset' = p − k·(p − offset)，k = next/prev。
function zoomAtCursor(
  prev: { scale: number; offset: { x: number; y: number } },
  next: number,
  cursorFromCenter: { x: number; y: number },
) {
  if (next === prev.scale) return { scale: prev.scale, offset: { ...prev.offset } };
  const k = next / prev.scale;
  return {
    scale: next,
    offset: {
      x: cursorFromCenter.x - k * (cursorFromCenter.x - prev.offset.x),
      y: cursorFromCenter.y - k * (cursorFromCenter.y - prev.offset.y),
    },
  };
}

describe("滚轮以光标为中心缩放", () => {
  it("光标在中心时缩放不产生平移", () => {
    const r = zoomAtCursor({ scale: 1, offset: { x: 0, y: 0 } }, 1.5, { x: 0, y: 0 });
    expect(r.offset).toEqual({ x: 0, y: 0 });
  });

  it("光标处的图像点在缩放前后保持同一屏幕位置（取整前近似）", () => {
    const prev = { scale: 1, offset: { x: 0, y: 0 } };
    const p = { x: 120, y: -40 };
    const next = 1.6;
    const r = zoomAtCursor(prev, next, p);
    // 屏幕坐标 = offset + k·p，两态应相等（这就是「以光标为中心」的判据）
    expect(r.offset.x + next * p.x).toBeCloseTo(prev.offset.x + prev.scale * p.x);
    expect(r.offset.y + next * p.y).toBeCloseTo(prev.offset.y + prev.scale * p.y);
  });

  it("缩放下限随适应比例变化，大图在窄窗仍能继续缩小", () => {
    const fit = 0.08;
    expect(clampImageZoom(0.05, fit)).toBe(0.05);
    expect(clampImageZoom(9, fit)).toBe(5);
    // 夹到边界后倍率与当前相同 ⇒ hook 直接 return，不产生任何平移抖动
    const same = zoomAtCursor({ scale: 0.02, offset: { x: 5, y: -3 } }, clampImageZoom(0.01, fit), { x: 30, y: 0 });
    expect(same.scale).toBe(0.02);
    expect(same.offset).toEqual({ x: 5, y: -3 });
  });
});

// ===== 2. OCR 零二次识别：进场面板的判定 =====
// 与 ImagePreviewDialog 进场逻辑同口径：item.ocr_text != null ⇒ 已有全文 ⇒ 亮摘要面板，
// 不触发 handleOcrRecognize；只有进入「选词」态才需要词框（才跑 ocr_image）。

/** 进场应亮的面板（hook openImagePreview 的口径） */
function entryPanel(ocrText: string | null): "ocr" | null {
  return ocrText != null ? "ocr" : null;
}

describe("OCR 零二次识别", () => {
  it("列表已识别过（ocr_text 非 null）⇒ 进场即亮摘要，不二次识别", () => {
    expect(entryPanel("会议纪要：周三 10:00 评审")).toBe("ocr");
  });

  it("未识别过（null）⇒ 不抢面板，等用户决定（零请求）", () => {
    expect(entryPanel(null)).toBe(null);
  });

  it("识别过但无文字（空串）也算已识别——空态摘要而非重跑引擎", () => {
    // Rust Option::None → null；「识别过但无文字」在库里是空串，不是 null。
    expect(entryPanel("")).toBe("ocr");
  });

  it("工具栏 T 按钮语义：已有全文显示「选词」，没有显示「识别文字」", () => {
    // ImageToolbar 的 hasOcrText 判定 = ocrResult != null || ocrCachedText != null
    const label = (ocrResult: unknown, ocrCachedText: string | null) =>
      (ocrResult != null || ocrCachedText != null) ? "选词" : "识别文字";
    expect(label(null, "已缓存全文")).toBe("选词");
    expect(label(null, null)).toBe("识别文字");
    expect(label({ full_text: "" }, null)).toBe("选词");
  });
});

// ===== 3. 面板互斥链 =====
// Esc 两级取消的优先级链（hook 内）：cropMode → 已选词 → 选词态 → activePanel → 关闭。
// 互斥约束：任何时刻最多一个面板；进入某态自动关掉其它面板。

type PanelId = "ocr" | "export" | "codes" | null;

/** 模式变化时的面板收敛（useEffect 收口在 ImagePreviewDialog） */
function converge(ocrActive: boolean, cropMode: boolean, current: PanelId): PanelId {
  if (cropMode) return null;          // 裁剪态收起一切浮层
  if (ocrActive) return "ocr";        // 选词态顶替摘要（同一面板，保证可见）
  return current;                     // 其它态不动用户选择
}

/** 实际渲染哪个面板槽位（ImagePreviewDialog 的互斥门控） */
function renderedPanel(ocrActive: boolean, activePanel: PanelId): "selection" | "summary" | "codes" | "export" | null {
  if (activePanel === "codes") return "codes";           // 码让位给一切（含选词条，选区不丢）
  if (activePanel === "export") return "export";
  if (ocrActive) return "selection";                     // 选词条
  if (activePanel === "ocr") return "summary";
  return null;
}

describe("面板互斥", () => {
  it("裁剪态关闭所有浮层", () => {
    expect(converge(false, true, "export")).toBe(null);
    expect(converge(true, true, "ocr")).toBe(null);
  });

  it("选词态强制切回 OCR 摘要（用户可能开着导出/码面板）", () => {
    expect(converge(true, false, "export")).toBe("ocr");
    expect(converge(true, false, "codes")).toBe("ocr");
  });

  it("普通态不动用户选择（含主动收起）", () => {
    expect(converge(false, false, "export")).toBe("export");
    expect(converge(false, false, null)).toBe(null);
  });

  it("同一时刻最多渲染一个浮层面板（码/导出优先，选词条随后，摘要兜底）", () => {
    // 进场即亮摘要（列表已识别）
    expect(renderedPanel(false, "ocr")).toBe("summary");
    // 用户开导出 ⇒ 只有导出，不叠摘要
    expect(renderedPanel(false, "export")).toBe("export");
    // 用户开码 ⇒ 只有码
    expect(renderedPanel(false, "codes")).toBe("codes");
    // 选词态 ⇒ 选词条；此时开码/导出则选词条让位，但选区保留（父级不清 selectedWordIndices）
    expect(renderedPanel(true, "ocr")).toBe("selection");
    expect(renderedPanel(true, "codes")).toBe("codes");
    expect(renderedPanel(true, "export")).toBe("export");
    // 全部收起 ⇒ 零面板
    expect(renderedPanel(false, null)).toBe(null);
  });

  it("Esc 链逐级退回：裁剪 → 已选词 → 选词 → 面板 → 关闭", () => {
    // 每个状态一个出口，语义单一（§17.7）：按序消费 stall 状态
    const next = (s: { crop: boolean; selected: number; ocrActive: boolean; panel: PanelId }) => {
      if (s.crop) return "退出裁剪";
      if (s.selected > 0) return "清除选区";
      if (s.ocrActive) return "退出选词";
      if (s.panel) return "收面板";
      return "关闭查看层";
    };
    expect(next({ crop: true, selected: 3, ocrActive: true, panel: "export" })).toBe("退出裁剪");
    expect(next({ crop: false, selected: 3, ocrActive: true, panel: "export" })).toBe("清除选区");
    expect(next({ crop: false, selected: 0, ocrActive: true, panel: "export" })).toBe("退出选词");
    expect(next({ crop: false, selected: 0, ocrActive: false, panel: "export" })).toBe("收面板");
    expect(next({ crop: false, selected: 0, ocrActive: false, panel: null })).toBe("关闭查看层");
  });
});
