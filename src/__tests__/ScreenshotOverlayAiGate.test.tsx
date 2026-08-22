/**
 * ScreenshotOverlay · AI 出口红线回归测试。
 *
 * claude.md 规则 16 的两条红线，都必须由测试守住：
 * - AI 总开关未开时，AI 出口**零可见**。不能渲染出来再靠 handler 里 early return ——
 *   那是"点了没反应"的静默失败（AnnotToolbar:321 靠 aiOk 门控）。
 * - 识别文本里夹着密钥/密码形态时，先弹确认才允许发云端（:2704-2711）。
 *
 * 这一块是批 4 要提取成 useShotAi 的目标，行为先钉住。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, cleanup, screen } from "@testing-library/react";
import {
  setupShotEnv,
  cleanupShotEnv,
  renderOverlay,
  flush,
  ocrResult,
  enterAnnotate,
  q,
  type ShotEnv,
} from "./helpers/shotHarness";

let env: ShotEnv;

afterEach(() => {
  cleanup();
  cleanupShotEnv();
  vi.unstubAllGlobals();
});

/** 让标注态进入时的自动 OCR 返回指定文本 */
function withOcrText(text: string): void {
  env.setCommand("ocr_image", () => ({
    lines: ocrResult([{ text }]).lines,
    full_text: text,
  }));
}

const aiButton = () => q(".annot-toolbar .exit-ai");

describe("AI 总开关未开：出口零可见", () => {
  beforeEach(() => {
    env = setupShotEnv({ aiOn: false });
  });

  it("标注工具栏上没有 AI 按钮", async () => {
    withOcrText("这是一段可以处理的文字");
    await renderOverlay();
    await enterAnnotate();
    await flush();

    expect(aiButton()).toBeNull();
  });

  it("有识别文字也不出现（不是「有文字才显示」的逻辑）", async () => {
    withOcrText("身高 180 体重 70 公斤，今天天气很好");
    await renderOverlay();
    await enterAnnotate();
    await flush();

    // 确认 OCR 真的成功了，否则这条测试是假通过
    expect(env.countInvoke("ocr_image")).toBeGreaterThanOrEqual(1);
    expect(aiButton()).toBeNull();
  });
});

describe("AI 已开：出口可见且有文字才开面板", () => {
  beforeEach(() => {
    env = setupShotEnv({ aiOn: true });
  });

  it("AI 按钮出现", async () => {
    withOcrText("可以处理的文字");
    await renderOverlay();
    await enterAnnotate();
    await flush();

    expect(aiButton()).toBeTruthy();
  });

  it("图中没有文字时给出原因，不开空面板", async () => {
    env.setCommand("ocr_image", () => ({ lines: [], full_text: "" }));
    await renderOverlay();
    await enterAnnotate();
    await flush();

    fireEvent.click(aiButton()!);
    await flush(1);

    expect(screen.getByText(/图中未识别到文字，AI 没有可处理的内容/)).toBeTruthy();
    expect(q(".pop-layer")).toBeNull();
  });

  it("有文字时打开 AI 面板", async () => {
    withOcrText("请把这段话翻译一下");
    await renderOverlay();
    await enterAnnotate();
    await flush();

    fireEvent.click(aiButton()!);
    await flush();

    expect(q(".pop-layer")).toBeTruthy();
  });

  it("拉取动作列表失败时把原因显示在面板里", async () => {
    withOcrText("请把这段话翻译一下");
    env.failCommand("ai_list_actions", "后端未启动");
    await renderOverlay();
    await enterAnnotate();
    await flush();

    fireEvent.click(aiButton()!);
    await flush();

    expect(q(".pop-layer")).toBeTruthy();
    expect(screen.getByText(/后端未启动/)).toBeTruthy();
  });
});

describe("敏感内容红线：先确认才放行", () => {
  beforeEach(() => {
    env = setupShotEnv({ aiOn: true });
  });

  it("识别文本含 API Key 形态时弹确认", async () => {
    const confirmSpy = vi.fn().mockReturnValue(false);
    vi.stubGlobal("confirm", confirmSpy);
    withOcrText("配置项 sk-abcdefghijklmnopqrstuvwxyz0123 请勿外传");
    await renderOverlay();
    await enterAnnotate();
    await flush();

    fireEvent.click(aiButton()!);
    await flush(1);

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(String(confirmSpy.mock.calls[0][0])).toContain("API Key（sk-*）");
  });

  it("用户取消则面板不打开、不发云端", async () => {
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(false));
    withOcrText("password: hunter2secret");
    await renderOverlay();
    await enterAnnotate();
    await flush();

    fireEvent.click(aiButton()!);
    await flush();

    expect(q(".pop-layer")).toBeNull();
    expect(env.countInvoke("ai_run")).toBe(0);
  });

  it("用户确认则正常打开面板", async () => {
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    withOcrText("password: hunter2secret");
    await renderOverlay();
    await enterAnnotate();
    await flush();

    fireEvent.click(aiButton()!);
    await flush();

    expect(q(".pop-layer")).toBeTruthy();
  });

  it("普通文本不打扰用户", async () => {
    const confirmSpy = vi.fn().mockReturnValue(true);
    vi.stubGlobal("confirm", confirmSpy);
    withOcrText("会议时间改到下周三下午三点");
    await renderOverlay();
    await enterAnnotate();
    await flush();

    fireEvent.click(aiButton()!);
    await flush();

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(q(".pop-layer")).toBeTruthy();
  });
});
