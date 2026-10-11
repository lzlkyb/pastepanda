import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQrCanvas } from "@/hooks/useQrCanvas";
import { QREditor } from "@/components/editors/QREditor";
import { QRCodeDialog } from "@/components/QRCodeDialog";

const { toCanvas } = vi.hoisted(() => ({ toCanvas: vi.fn() }));
vi.mock("qrcode", () => ({ toCanvas }));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

beforeEach(() => { toCanvas.mockReset(); });
afterEach(cleanup);

describe("QR generation lifecycle", () => {
  const canvas = { current: document.createElement("canvas") };

  it("does not generate or report failure for empty text", async () => {
    const { result } = renderHook(() => useQrCanvas(canvas, "", 240));
    await act(async () => {});
    expect(result.current).toMatchObject({ empty: true, ready: false, error: false });
    expect(toCanvas).not.toHaveBeenCalled();
  });

  it("generates nonempty text with the requested resolution", async () => {
    toCanvas.mockImplementation((_canvas, _text, _opts, done) => done(null));
    const { result } = renderHook(() => useQrCanvas(canvas, "audit", 360));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(toCanvas.mock.calls[0][1]).toBe("audit");
    expect(toCanvas.mock.calls[0][2].width).toBe(360);
  });

  it("ignores a late completion after text is cleared", async () => {
    const { result, rerender } = renderHook(({ text }) => useQrCanvas(canvas, text, 240), { initialProps: { text: "audit" } });
    await waitFor(() => expect(toCanvas).toHaveBeenCalledOnce());
    const done = toCanvas.mock.calls[0][3];
    rerender({ text: "" });
    act(() => done(null));
    expect(result.current).toMatchObject({ empty: true, ready: false, error: false });
  });

  it("does not generate while the decode view is active", async () => {
    renderHook(() => useQrCanvas(canvas, "audit", 240, false));
    await act(async () => {});
    expect(toCanvas).not.toHaveBeenCalled();
  });

  it("rejects oversized UTF-8 content before calling the generator", () => {
    const { result } = renderHook(() => useQrCanvas(canvas, "汉".repeat(667), 240));
    expect(result.current).toMatchObject({ error: true, ready: false, tooLong: true, textBytes: 2001 });
    expect(toCanvas).not.toHaveBeenCalled();
  });

  it("retries a real generation error", async () => {
    toCanvas.mockImplementationOnce((_canvas, _text, _opts, done) => done(new Error("failed")))
      .mockImplementationOnce((_canvas, _text, _opts, done) => done(null));
    const { result } = renderHook(() => useQrCanvas(canvas, "audit", 240));
    await waitFor(() => expect(result.current.error).toBe(true));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.error).toBe(false);
  });
});

describe("empty QR entry points", () => {
  it("the editable workbench waits for input and disables image export", async () => {
    render(<QREditor initialText="" onClose={vi.fn()} />);
    await act(async () => {});
    expect(screen.getByText("等待文本内容")).toBeTruthy();
    expect(screen.queryByText("生成失败")).toBeNull();
    expect((screen.getByRole("button", { name: "保存 PNG" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the read-only QR dialog uses the same empty state", async () => {
    render(<QRCodeDialog text="" onClose={vi.fn()} />);
    await act(async () => {});
    expect(screen.getByText("等待文本内容")).toBeTruthy();
    expect(screen.queryByText("生成失败")).toBeNull();
    expect((screen.getByRole("button", { name: "复制图片" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
