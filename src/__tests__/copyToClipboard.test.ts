/**
 * copyToClipboard 的路径顺序守卫。
 *
 * 背景（真实故障）：图片 OCR 面板「复制全部」提示「✓ 已复制」，用户粘出来还是旧内容。
 * 根因是 Web Clipboard 的 `writeText` 在 WebView2 里会 **resolve 却不写**（窗口未聚焦 /
 * 失去用户激活时静默丢写），旧实现以它为首选 ⇒ 假成功被当成成功上报。
 *
 * 所以这里守的不是"能复制"，而是**顺序**：
 * 1. 桌面端必须先走 Rust `copy_only`（有重试 + 回读校验 + 真实错误）；
 * 2. 原生报「回读不一致」时**不许**再回落 Web API —— 那会二次制造假成功。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { copyToClipboard } from "@/lib/utils";

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  writeText.mockReset();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

describe("copyToClipboard", () => {
  it("桌面端优先走原生 copy_only，不碰 Web Clipboard", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    writeText.mockResolvedValue(undefined);

    await expect(copyToClipboard("识别到的文字")).resolves.toBe(true);

    expect(invoke).toHaveBeenCalledWith("copy_only", { text: "识别到的文字" });
    // 关键断言：优先 writeText 的旧实现会在这里变红
    expect(writeText).not.toHaveBeenCalled();
  });

  it("原生不可用（移动端 / 无 Tauri）时回落 Web Clipboard", async () => {
    vi.mocked(invoke).mockRejectedValue("当前平台没有系统剪贴板引擎，请走 Web Clipboard");
    writeText.mockResolvedValue(undefined);

    await expect(copyToClipboard("abc")).resolves.toBe(true);

    expect(writeText).toHaveBeenCalledWith("abc");
  });

  it("原生报「回读不一致」直接判失败，不再拿浏览器的 resolve 当成功", async () => {
    vi.mocked(invoke).mockRejectedValue(
      "复制后回读不一致（写入 3 字符，回读 0 字符）：剪贴板被其它程序抢占，内容没有真正落地",
    );
    writeText.mockResolvedValue(undefined); // 浏览器照样"成功"——这正是要防的假绿

    await expect(copyToClipboard("abc")).resolves.toBe(false);

    expect(writeText).not.toHaveBeenCalled();
  });

  it("两条路径都失败时返回 false", async () => {
    vi.mocked(invoke).mockRejectedValue("剪贴板写入被拒");
    writeText.mockRejectedValue(new Error("NotAllowedError"));

    await expect(copyToClipboard("abc")).resolves.toBe(false);
  });
});
