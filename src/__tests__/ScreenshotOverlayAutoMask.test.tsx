/**
 * ScreenshotOverlay · 自动打码回归测试。
 *
 * 最要紧的一条是 :1463 记下的历史 bug：命中隐私就盖**整行**。
 * 「客服电话 13800138000 工作时间 9:00-18:00」会被整条涂黑，用户想留的内容一起没了。
 * 正确行为是只盖命中的那几个字。这条用几何断言钉死。
 *
 * 触发路径（自动打码 hidden:true，不在主栏）：进标注态 → 选马赛克 → 属性栏点「自动打码」。
 */

import { describe, it, expect, beforeEach, beforeAll, afterEach } from "vitest";
import { fireEvent, cleanup, screen } from "@testing-library/react";
import {
  setupShotEnv,
  cleanupShotEnv,
  renderOverlay,
  flush,
  ocrResult,
  enterAnnotate,
  clickTool,
  clickAttr,
  canUndo,
  clickUndo,
  q,
  qq,
  attrBar,
  type ShotEnv,
} from "./helpers/shotHarness";

let env: ShotEnv;

// runAutoMask 内部有 `await import("jsqr")`（二维码兜底扫描）。那是**真实的**动态导入，
// 首次加载耗时会超过 flush 的等待轮数 —— 不预热的话本文件第一个用例会拿到空预览而失败，
// 后面的用例反而因为模块已缓存而通过。预热掉这个一次性成本比盲目加 flush 轮数更确定。
beforeAll(async () => {
  await import("jsqr");
});

beforeEach(() => {
  env = setupShotEnv();
});

afterEach(() => {
  cleanup();
  cleanupShotEnv();
});

/** 走完「渲染 → 进标注 → 选马赛克 → 点自动打码」并等异步 OCR 落地 */
async function runAutoMask(): Promise<void> {
  await renderOverlay();
  await enterAnnotate();
  clickTool("马赛克");
  await flush(1);
  if (!attrBar()) throw new Error("选了马赛克但属性栏没出现");
  clickAttr("自动打码");
  await flush();
}

/** 取所有预览框的几何（CSS 像素，dpr=1 下与物理像素等值） */
function previewBoxes(): { left: number; top: number; width: number; height: number }[] {
  return qq(".mask-preview").map((el) => ({
    left: Number.parseFloat(el.style.left),
    top: Number.parseFloat(el.style.top),
    width: Number.parseFloat(el.style.width),
    height: Number.parseFloat(el.style.height),
  }));
}

describe("只盖命中的字，不盖整行", () => {
  it("长行里只有手机号那段被框住", async () => {
    // 21 个字符：客服电话(0-3) 空格(4) 手机号(5-15) 空格(16) 工作时间(17-20)
    // 起点 x=100，每字 10px 宽 → 整行占 100..310
    env.setCommand("ocr_image", () => ({
      lines: ocrResult([{ text: "客服电话 13800138000 工作时间", x: 100, y: 200, charW: 10, h: 20 }])
        .lines,
      full_text: "客服电话 13800138000 工作时间",
    }));
    await runAutoMask();

    const boxes = previewBoxes();
    expect(boxes).toHaveLength(1);

    // 手机号字符区间 [5,16) → 物理 150..260，外扩 pad=4 → 146..264，宽 118
    expect(boxes[0].left).toBe(146);
    expect(boxes[0].width).toBe(118);

    // 关键回归：绝不能是整行（整行外扩后是 96..314，宽 218）
    expect(boxes[0].width).toBeLessThan(150);
    expect(boxes[0].left).toBeGreaterThan(100);
  });

  it("一行里两段隐私各自成框", async () => {
    const text = "13800138000 和 13900139000";
    env.setCommand("ocr_image", () => ({
      lines: ocrResult([{ text, x: 0, y: 100, charW: 10, h: 20 }]).lines,
      full_text: text,
    }));
    await runAutoMask();

    expect(previewBoxes().length).toBeGreaterThanOrEqual(2);
  });

  it("没有逐字符 bbox 时退回盖整行（兼容分支）", async () => {
    const text = "客服电话 13800138000 工作时间";
    env.setCommand("ocr_image", () => ({
      // perChar:false → words 只有整行一个框，定位不到子串
      lines: ocrResult([{ text, x: 100, y: 200, charW: 10, h: 20 }], { perChar: false }).lines,
      full_text: text,
    }));
    await runAutoMask();

    const boxes = previewBoxes();
    expect(boxes).toHaveLength(1);
    // 整行 100..310 外扩 4 → 96..314，宽 218
    expect(boxes[0].width).toBe(218);
  });

  it("没有隐私内容时不打码并明确告知", async () => {
    env.setCommand("ocr_image", () => ({
      lines: ocrResult([{ text: "今天天气不错，适合出门散步" }]).lines,
      full_text: "今天天气不错，适合出门散步",
    }));
    await runAutoMask();

    expect(qq(".mask-preview")).toHaveLength(0);
    expect(screen.getByText(/未发现可打码的隐私信息/)).toBeTruthy();
  });

  it("OCR 不可用时报失败，不静默什么都不做", async () => {
    env.failCommand("ocr_image", "OCR 引擎未安装");
    await runAutoMask();

    expect(qq(".mask-preview")).toHaveLength(0);
    expect(screen.getByText(/自动打码失败：文字识别未就绪/)).toBeTruthy();
  });
});

describe("预览式：先确认再打码", () => {
  beforeEach(() => {
    const text = "手机 13800138000";
    env.setCommand("ocr_image", () => ({
      lines: ocrResult([{ text, x: 100, y: 200, charW: 10, h: 20 }]).lines,
      full_text: text,
    }));
  });

  it("先出橙框预览与计数，而不是直接打码", async () => {
    await runAutoMask();

    expect(qq(".mask-preview")).toHaveLength(1);
    // "识别到 1 处隐私" 同时出现在 toast 和确认条标题里，所以按元素定位而不是按文本全局搜
    expect(q(".mask-title")!.textContent).toContain("识别到 1 处隐私");
    // 预览阶段还没有产生任何标注 → 撤销栈仍是空的
    expect(canUndo()).toBe(false);
  });

  it("点框排除后计数减少，确认按钮跟着变", async () => {
    await runAutoMask();
    expect(q(".mask-confirm")!.textContent).toContain("1");

    fireEvent.click(q(".mask-preview")!);
    await flush(1);

    expect(q(".mask-preview")!.className).toContain("excluded");
    expect(q(".mask-preview")!.textContent).toContain("已排除");
    expect(q(".mask-confirm")!.textContent).toContain("0");
  });

  it("再点一次恢复参与打码", async () => {
    await runAutoMask();
    fireEvent.click(q(".mask-preview")!);
    await flush(1);
    expect(q(".mask-preview")!.className).toContain("excluded");

    fireEvent.click(q(".mask-preview")!);
    await flush(1);
    expect(q(".mask-preview")!.className).not.toContain("excluded");
    expect(q(".mask-confirm")!.textContent).toContain("1");
  });

  it("全部排除后确认：不打码并告知", async () => {
    await runAutoMask();
    fireEvent.click(q(".mask-preview")!);
    await flush(1);

    fireEvent.click(q(".mask-confirm")!);
    await flush(1);

    expect(screen.getByText(/已排除全部，未打码/)).toBeTruthy();
    expect(canUndo()).toBe(false);
  });

  it("放弃则清掉预览且不留标注", async () => {
    await runAutoMask();
    expect(qq(".mask-preview")).toHaveLength(1);

    fireEvent.click(q(".mask-cancel")!);
    await flush(1);

    expect(qq(".mask-preview")).toHaveLength(0);
    expect(canUndo()).toBe(false);
  });
});

describe("整批一次入撤销栈", () => {
  it("三处隐私一次确认后，按一次撤销全部退回", async () => {
    const text = "13800138000 13900139000 13700137000";
    env.setCommand("ocr_image", () => ({
      lines: ocrResult([{ text, x: 0, y: 100, charW: 10, h: 20 }]).lines,
      full_text: text,
    }));
    await runAutoMask();

    const n = qq(".mask-preview").length;
    expect(n).toBeGreaterThanOrEqual(3);

    fireEvent.click(q(".mask-confirm")!);
    await flush(1);

    expect(screen.getByText(new RegExp(`已自动打码 ${n} 处`))).toBeTruthy();
    expect(qq(".mask-preview")).toHaveLength(0);
    expect(canUndo()).toBe(true);

    // 关键：整批只占一格撤销栈 —— 按一次就该退干净，而不是要按 n 次
    clickUndo();
    await flush(1);
    expect(canUndo()).toBe(false);
  });
});

describe("OCR 结果复用", () => {
  it("已有识别结果时不再重复跑 OCR", async () => {
    const text = "手机 13800138000";
    env.setCommand("ocr_image", () => ({
      lines: ocrResult([{ text, x: 100, y: 200, charW: 10, h: 20 }]).lines,
      full_text: text,
    }));
    await runAutoMask();
    const first = env.countInvoke("ocr_image");
    expect(first).toBeGreaterThanOrEqual(1);

    // 放弃预览后再来一次：应命中已有 ocr，不再打后端
    fireEvent.click(q(".mask-cancel")!);
    await flush(1);
    clickAttr("自动打码");
    await flush();

    expect(env.countInvoke("ocr_image")).toBe(first);
    expect(qq(".mask-preview")).toHaveLength(1);
  });

  it("OCR 临时文件会登记，供关窗时清理", async () => {
    const text = "手机 13800138000";
    env.setCommand("ocr_image", () => ({
      lines: ocrResult([{ text, x: 100, y: 200, charW: 10, h: 20 }]).lines,
      full_text: text,
    }));
    await runAutoMask();

    expect(env.countInvoke("save_screenshot_image")).toBeGreaterThanOrEqual(1);
    expect(env.countInvoke("mark_ocr_temp")).toBeGreaterThanOrEqual(1);
  });
});
