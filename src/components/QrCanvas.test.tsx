/**
 * QrCanvas 守卫单测（规则 11.1）：钉住「出码口径」这条不变量——
 * 任何调用点都走深块浅底、margin:2、errorCorrectionLevel "M"，且空文本绝不出码。
 * 若哪天有人新增第三个二维码调用点又自带 toCanvas 参数，这个口径就是判定它跑偏的锚。
 */
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QrCanvas } from "./QrCanvas";

const toCanvas = vi.fn().mockResolvedValue(undefined);
vi.mock("qrcode", () => ({ toCanvas }));

describe("QrCanvas", () => {
  beforeEach(() => toCanvas.mockClear());

  it("把文本按钉死的口径画进画布，画好后 data-ready 翻 1 且回报 onReady", async () => {
    const onReady = vi.fn();
    const { container } = render(<QrCanvas text="https://pastepanda.pages.dev/#android" size={140} onReady={onReady} />);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    await waitFor(() => expect(canvas.getAttribute("data-ready")).toBe("1"));
    expect(toCanvas).toHaveBeenCalledWith(
      canvas,
      "https://pastepanda.pages.dev/#android",
      { width: 140, margin: 2, errorCorrectionLevel: "M" },
    );
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("出码失败：回报 onError、不报 onReady、data-ready 保持 0", async () => {
    toCanvas.mockRejectedValueOnce(new Error("boom"));
    const onError = vi.fn();
    const onReady = vi.fn();
    const { container } = render(<QrCanvas text="https://x.dev" size={140} onError={onError} onReady={onReady} />);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onReady).not.toHaveBeenCalled();
    expect(canvas.getAttribute("data-ready")).toBe("0");
  });

  it("空文本不出码（data-ready 保持 0，toCanvas 不调用）", async () => {
    const { container } = render(<QrCanvas text="" />);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    await new Promise((r) => setTimeout(r, 0));
    expect(canvas.getAttribute("data-ready")).toBe("0");
    expect(toCanvas).not.toHaveBeenCalled();
  });
});
