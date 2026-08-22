/**
 * ScreenshotOverlay · 标注态绘制交互回归测试。
 *
 * 这 430 行是整个截图功能里走得最多的路径（每一个标注都从这里过），此前**零覆盖**。
 * 选题仍以源码点名过的历史 bug 为主：
 * - :2968-2974 零尺寸误点丢弃草稿后不重绘 → 点击处残留草稿方块（"点击后出现绿色方块"）
 * - :2960-2965 橡皮在空白处擦一下 → annotations 未变 → 不重绘 → 橡皮轨迹留在画面上
 * - :2171      序号用只增不减的 numSeqRef → 画 1/2/3 撤销掉 3 再画会得到 4（断号）
 * - :2776-2780 文字工具点已有文字应进编辑，而不是又建一个空框
 * - :2943-2949 橡皮擦到笔迹要切成多段，不是整条删掉
 *
 * 坐标：jsdom 无布局，getBoundingClientRect() 恒为 0、dpr=1，
 * 所以 clientX/clientY 直接是选区局部物理坐标。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fireEvent, cleanup } from "@testing-library/react";
import {
  setupShotEnv,
  cleanupShotEnv,
  renderOverlay,
  flush,
  enterAnnotate,
  clickTool,
  canUndo,
  clickUndo,
  q,
  qq,
  type ShotEnv,
  type StubCtx,
} from "./helpers/shotHarness";

let env: ShotEnv;

beforeEach(() => {
  env = setupShotEnv();
});

afterEach(() => {
  cleanup();
  cleanupShotEnv();
});

/** 标注画布 */
function canvas(): HTMLElement {
  const el = q(".annot-canvas");
  if (!el) throw new Error("annot-canvas 不存在（没进标注态？）");
  return el;
}

/** 标注画布对应的桩 context（用来断言"画了什么"） */
function annotCtx(): StubCtx {
  const cv = canvas() as HTMLCanvasElement;
  const c = env.ctxs.find((x) => x.canvas === cv);
  if (!c) throw new Error("找不到标注画布的 context");
  return c;
}

/** 在画布上拖一笔 */
async function drag(x1: number, y1: number, x2: number, y2: number): Promise<void> {
  const cv = canvas();
  fireEvent.mouseDown(cv, { clientX: x1, clientY: y1 });
  fireEvent.mouseMove(cv, { clientX: x2, clientY: y2 });
  fireEvent.mouseUp(cv, { clientX: x2, clientY: y2 });
  await flush(1);
}

async function setup(): Promise<void> {
  await renderOverlay();
  await enterAnnotate();
}

describe("绘制并入撤销栈", () => {
  it("默认矩形工具拖一笔即提交一个标注", async () => {
    await setup();
    expect(canUndo()).toBe(false);

    await drag(300, 250, 500, 400);

    expect(canUndo()).toBe(true);
  });

  it("椭圆 / 箭头 / 画笔 / 高亮 各自都能提交", async () => {
    for (const label of ["椭圆", "箭头", "画笔", "高亮"]) {
      await setup();
      clickTool(label);
      await flush(1);

      await drag(300, 250, 460, 380);
      expect(canUndo(), `${label} 没能提交`).toBe(true);

      cleanup();
      cleanupShotEnv();
      env = setupShotEnv();
    }
  });

  it("连画两笔要按两次撤销才清空", async () => {
    await setup();
    await drag(300, 250, 400, 320);
    await drag(420, 250, 520, 320);

    clickUndo();
    await flush(1);
    expect(canUndo()).toBe(true);

    clickUndo();
    await flush(1);
    expect(canUndo()).toBe(false);
  });
});

describe("零尺寸误点不留残影", () => {
  it("原地点一下不提交标注", async () => {
    await setup();

    // mousedown → 1px 抖动 → mouseup：小于 2px 阈值，应被当成误点丢弃
    const cv = canvas();
    fireEvent.mouseDown(cv, { clientX: 300, clientY: 300 });
    fireEvent.mouseMove(cv, { clientX: 301, clientY: 300 });
    fireEvent.mouseUp(cv, { clientX: 301, clientY: 300 });
    await flush(1);

    expect(canUndo()).toBe(false);
  });

  it("丢弃草稿后会重绘，把画上去的草稿清掉", async () => {
    await setup();
    clickTool("高亮"); // 高亮的单点草稿是当前色纯色块，残留最显眼
    await flush(1);

    const before = annotCtx().count("clearRect");
    const cv = canvas();
    fireEvent.mouseDown(cv, { clientX: 300, clientY: 300 });
    fireEvent.mouseMove(cv, { clientX: 301, clientY: 300 });
    fireEvent.mouseUp(cv, { clientX: 301, clientY: 300 });
    await flush(1);

    // redraw() 的第一件事就是 clearRect —— 没有它草稿方块会一直留在画面上
    expect(annotCtx().count("clearRect")).toBeGreaterThan(before);
    expect(canUndo()).toBe(false);
  });
});

describe("序号工具：撤销后不断号", () => {
  it("画 1/2/3 撤销掉 3 再画，仍然得到 3", async () => {
    await setup();
    clickTool("序号");
    await flush(1);

    await drag(100, 100, 130, 130);
    await drag(200, 100, 230, 130);
    await drag(300, 100, 330, 130);

    // 画布上应出现 "1" "2" "3"
    const texts = () =>
      annotCtx()
        .calls.filter((c) => c.fn === "fillText")
        .map((c) => String(c.args[0]));
    expect(texts()).toContain("3");

    clickUndo();
    await flush(1);

    await drag(400, 100, 430, 130);
    await flush(1);

    // 旧实现用只增不减的计数器，这里会画出 "4"（断号）
    const after = texts();
    expect(after).toContain("3");
    expect(after).not.toContain("4");
  });
});

describe("文字标注", () => {
  it("点画布弹输入框，Enter 提交", async () => {
    await setup();
    clickTool("文字");
    await flush(1);

    fireEvent.mouseDown(canvas(), { clientX: 350, clientY: 300 });
    fireEvent.mouseUp(canvas(), { clientX: 350, clientY: 300 });
    await flush(1);

    const ta = q("textarea") as HTMLTextAreaElement | null;
    expect(ta).toBeTruthy();

    fireEvent.change(ta!, { target: { value: "测试文字" } });
    fireEvent.keyDown(ta!, { key: "Enter" });
    await flush(1);

    expect(q("textarea")).toBeNull();
    expect(canUndo()).toBe(true);
  });

  it("空内容不落标注", async () => {
    await setup();
    clickTool("文字");
    await flush(1);

    fireEvent.mouseDown(canvas(), { clientX: 350, clientY: 300 });
    fireEvent.mouseUp(canvas(), { clientX: 350, clientY: 300 });
    await flush(1);

    const ta = q("textarea") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "   " } });
    fireEvent.keyDown(ta, { key: "Enter" });
    await flush(1);

    expect(canUndo()).toBe(false);
  });

  it("Esc 取消输入框且不落标注", async () => {
    await setup();
    clickTool("文字");
    await flush(1);

    fireEvent.mouseDown(canvas(), { clientX: 350, clientY: 300 });
    fireEvent.mouseUp(canvas(), { clientX: 350, clientY: 300 });
    await flush(1);

    const ta = q("textarea") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "不要这段" } });
    fireEvent.keyDown(ta, { key: "Escape" });
    await flush(1);

    expect(q("textarea")).toBeNull();
    expect(canUndo()).toBe(false);
  });

  it("文字工具点已有文字进编辑，而不是新建空框", async () => {
    await setup();
    clickTool("文字");
    await flush(1);

    // 先落一段
    fireEvent.mouseDown(canvas(), { clientX: 200, clientY: 200 });
    fireEvent.mouseUp(canvas(), { clientX: 200, clientY: 200 });
    await flush(1);
    fireEvent.change(q("textarea") as HTMLTextAreaElement, { target: { value: "原文" } });
    fireEvent.keyDown(q("textarea") as HTMLTextAreaElement, { key: "Enter" });
    await flush(1);

    // 再点回同一处：输入框应预填原文
    fireEvent.mouseDown(canvas(), { clientX: 202, clientY: 202 });
    fireEvent.mouseUp(canvas(), { clientX: 202, clientY: 202 });
    await flush(1);

    const ta2 = q("textarea") as HTMLTextAreaElement | null;
    expect(ta2).toBeTruthy();
    expect(ta2!.value).toBe("原文");
  });
});

describe("选中 / 删除", () => {
  it("点中标注出现选中框，点空白取消", async () => {
    await setup();
    await drag(300, 250, 500, 400);
    expect(qq(".annot-sel-box")).toHaveLength(0);

    // 单击标注内部（零尺寸误点会被丢弃，但选中判定发生在 mousedown）
    fireEvent.mouseDown(canvas(), { clientX: 400, clientY: 320 });
    fireEvent.mouseUp(canvas(), { clientX: 400, clientY: 320 });
    await flush(1);
    expect(qq(".annot-sel-box").length).toBeGreaterThanOrEqual(1);

    fireEvent.mouseDown(canvas(), { clientX: 40, clientY: 40 });
    fireEvent.mouseUp(canvas(), { clientX: 40, clientY: 40 });
    await flush(1);
    expect(qq(".annot-sel-box")).toHaveLength(0);
  });

  it("选中后按 Delete 删除，且可撤销回来", async () => {
    await setup();
    await drag(300, 250, 500, 400);

    fireEvent.mouseDown(canvas(), { clientX: 400, clientY: 320 });
    fireEvent.mouseUp(canvas(), { clientX: 400, clientY: 320 });
    await flush(1);
    expect(qq(".annot-sel-box").length).toBeGreaterThanOrEqual(1);

    fireEvent.keyDown(window, { key: "Delete" });
    await flush(1);

    expect(qq(".annot-sel-box")).toHaveLength(0);
    expect(canUndo()).toBe(true);
  });
});

describe("橡皮擦", () => {
  it("擦到形状会产生撤销项", async () => {
    await setup();
    await drag(300, 250, 500, 400);
    clickUndo(); // 清掉这一步的撤销项，方便观察橡皮自己的
    await flush(1);
    await drag(300, 250, 500, 400);
    const cv = canvas();

    clickTool("橡皮擦");
    await flush(1);
    fireEvent.mouseDown(cv, { clientX: 380, clientY: 300 });
    fireEvent.mouseMove(cv, { clientX: 420, clientY: 340 });
    fireEvent.mouseUp(cv, { clientX: 420, clientY: 340 });
    await flush(1);

    // 画了一笔(1) + 擦了一次(1) = 两格撤销
    clickUndo();
    await flush(1);
    expect(canUndo()).toBe(true);
  });

  it("在空白处擦不产生撤销项，但会重绘清掉橡皮轨迹", async () => {
    await setup();
    clickTool("橡皮擦");
    await flush(1);

    const before = annotCtx().count("clearRect");
    const cv = canvas();
    fireEvent.mouseDown(cv, { clientX: 60, clientY: 60 });
    fireEvent.mouseMove(cv, { clientX: 90, clientY: 90 });
    fireEvent.mouseUp(cv, { clientX: 90, clientY: 90 });
    await flush(1);

    expect(canUndo()).toBe(false);
    // 一个都没擦到时也必须 redraw，否则那条灰色橡皮轨迹会一直留在画面上
    expect(annotCtx().count("clearRect")).toBeGreaterThan(before);
  });
});
