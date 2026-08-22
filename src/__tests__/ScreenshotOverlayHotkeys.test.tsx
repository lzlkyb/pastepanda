/**
 * ScreenshotOverlay · 快捷键回归测试。
 *
 * 这 308 行是批 7 要提取成 useShotHotkeys 的目标，也是最容易在提取时出错的一块 ——
 * 它的依赖表（:1263-1266）有 10 个 state，源码注释（:1256-1261）点名了三个
 * 「闭包不重建就会捕获旧值」的真实 bug：
 *   ① 没有 textDraft：文字输入框开着时按 T 会被当成"复制全文"、方向键会去挪选区
 *   ② 没有 ocr：一笔未画时闭包不重建，Ctrl+R / T 拿不到识别结果
 *   ③ 没有 editorTarget：result 态 Ctrl+Enter 误判"没有文档可插入"
 * 这里把 ① 和 ② 钉住（③ 需要 result 态 + 编辑器上下文，留给后续）。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fireEvent, cleanup, screen } from "@testing-library/react";
import {
  setupShotEnv,
  cleanupShotEnv,
  renderOverlay,
  flush,
  ocrResult,
  enterAnnotate,
  clickTool,
  canUndo,
  shotRoot,
  q,
  qq,
  toolbar,
  type ShotEnv,
} from "./helpers/shotHarness";

let env: ShotEnv;

beforeEach(() => {
  env = setupShotEnv();
});

afterEach(() => {
  cleanup();
  cleanupShotEnv();
});

const key = (k: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(window, { key: k, ...init });

/** 当前高亮的工具标签 */
function activeTool(): string | null {
  const on = qq(".annot-toolbar .tool.on")[0];
  return on?.textContent?.trim() ?? null;
}

function withOcrText(text: string): void {
  env.setCommand("ocr_image", () => ({
    lines: ocrResult([{ text }]).lines,
    full_text: text,
  }));
}

describe("Esc 退出", () => {
  it("选区态按 Esc 关闭截图窗口", async () => {
    await renderOverlay();

    key("Escape");
    await flush(1);

    expect(env.countInvoke("close_screenshot_window")).toBe(1);
  });

  it("标注态按 Esc 不直接关窗（先退回选区）", async () => {
    await renderOverlay();
    await enterAnnotate();

    key("Escape");
    await flush(1);

    expect(env.countInvoke("close_screenshot_window")).toBe(0);
  });
});

describe("数字键切换工具", () => {
  it("按 2 切到椭圆", async () => {
    await renderOverlay();
    await enterAnnotate();
    expect(activeTool()).toBe("矩形");

    key("2");
    await flush(1);

    expect(activeTool()).toBe("椭圆");
  });

  it("按 8 切到文字、按 9 切到序号", async () => {
    await renderOverlay();
    await enterAnnotate();

    key("8");
    await flush(1);
    expect(activeTool()).toBe("文字");

    key("9");
    await flush(1);
    expect(activeTool()).toBe("序号");
  });

  it("选区态下数字键不切工具", async () => {
    await renderOverlay();

    key("2");
    await flush(1);

    // 还没进标注态，工具栏都不存在
    expect(toolbar()).toBeNull();
  });
});

describe("撤销 / 重做", () => {
  it("画一笔后 Ctrl+Z 退回，Ctrl+Y 重做", async () => {
    await renderOverlay();
    await enterAnnotate();
    expect(canUndo()).toBe(false);

    // 在标注画布上拖一个矩形
    const cv = q(".annot-canvas") ?? shotRoot();
    fireEvent.mouseDown(cv, { clientX: 300, clientY: 250 });
    fireEvent.mouseMove(cv, { clientX: 500, clientY: 400 });
    fireEvent.mouseUp(cv, { clientX: 500, clientY: 400 });
    await flush(1);
    expect(canUndo()).toBe(true);

    key("z", { ctrlKey: true });
    await flush(1);
    expect(canUndo()).toBe(false);

    key("y", { ctrlKey: true });
    await flush(1);
    expect(canUndo()).toBe(true);
  });

  it("栈空时 Ctrl+Z 无副作用", async () => {
    await renderOverlay();
    await enterAnnotate();

    key("z", { ctrlKey: true });
    await flush(1);

    expect(canUndo()).toBe(false);
    expect(toolbar()).toBeTruthy();
  });
});

describe("T 键复制识别全文", () => {
  it("有识别结果时复制并提示行数", async () => {
    withOcrText("第一行文字");
    await renderOverlay();
    await enterAnnotate();
    await flush();

    key("t");
    await flush(1);

    expect(screen.getByText(/已复制 1 行文字/)).toBeTruthy();
  });

  it("没有识别结果时明确告知，不静默", async () => {
    env.setCommand("ocr_image", () => ({ lines: [], full_text: "" }));
    await renderOverlay();
    await enterAnnotate();
    await flush();

    key("t");
    await flush(1);

    expect(screen.getByText(/图中未识别到文字/)).toBeTruthy();
  });

  it("带 Ctrl 的 T 不归快捷键管", async () => {
    withOcrText("第一行文字");
    await renderOverlay();
    await enterAnnotate();
    await flush();

    key("t", { ctrlKey: true });
    await flush(1);

    expect(q(".shot-toast")).toBeNull();
  });
});

describe("文字输入框开着时不劫持按键（闭包陈旧值 bug ①）", () => {
  /** 切到文字工具并在画布上点一下，弹出输入框 */
  async function openTextDraft(): Promise<HTMLTextAreaElement> {
    await renderOverlay();
    await enterAnnotate();
    await flush();
    clickTool("文字");
    await flush(1);

    const cv = q(".annot-canvas") ?? shotRoot();
    fireEvent.mouseDown(cv, { clientX: 350, clientY: 300 });
    fireEvent.mouseUp(cv, { clientX: 350, clientY: 300 });
    await flush(1);

    const ta = q("textarea") as HTMLTextAreaElement | null;
    if (!ta) throw new Error("文字输入框没弹出来");
    return ta;
  }

  // 真实路径：输入框聚焦时按键的 target 就是 textarea 本身，
  // 由 :967-970 的 isTextInput 守卫挡住（Escape 除外）。
  it("在输入框里按 T 是打字，不触发复制全文", async () => {
    withOcrText("这是识别出来的文字");
    const ta = await openTextDraft();

    fireEvent.keyDown(ta, { key: "t" });
    await flush(1);

    expect(screen.queryByText(/已复制/)).toBeNull();
  });

  it("在输入框里按数字键是打字，不切换工具", async () => {
    withOcrText("这是识别出来的文字");
    const ta = await openTextDraft();

    fireEvent.keyDown(ta, { key: "2" });
    await flush(1);

    expect(activeTool()).toBe("文字");
  });

  it("在输入框里按 Esc 仍然生效（唯一放行的键）", async () => {
    withOcrText("这是识别出来的文字");
    const ta = await openTextDraft();

    fireEvent.keyDown(ta, { key: "Escape" });
    await flush(1);

    // Esc 不被 isTextInput 拦，输入框应被撤下
    expect(q("textarea")).toBeNull();
  });

  // 第二层守卫：焦点**不在**输入框上（比如刚用鼠标点过工具按钮）但草稿还开着。
  // 这时 target 不是 textarea，isTextInput 放行，靠 T 分支自己的 `!textDraft` 兜住。
  it("焦点不在输入框但草稿开着时，T 仍不复制全文", async () => {
    withOcrText("这是识别出来的文字");
    await openTextDraft();

    key("t");
    await flush(1);

    expect(screen.queryByText(/已复制/)).toBeNull();
  });

  it("同一情形下数字键**会**切工具（两层守卫口径不同，如实记录）", async () => {
    withOcrText("这是识别出来的文字");
    await openTextDraft();

    key("2");
    await flush(1);

    // T 分支显式判了 !textDraft，工具切换分支没有 —— 所以焦点离开输入框后
    // 数字键照常切工具。是否算 bug 有待商定：切工具本身也可以理解为"放弃这段草稿"。
    // 本批只钉住现状，不改行为。
    expect(activeTool()).toBe("椭圆");
  });
});
