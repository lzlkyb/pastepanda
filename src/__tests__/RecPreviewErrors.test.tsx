import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RecPreview } from "@/components/recsel/RecPreview";
const api = vi.hoisted(() => ({ recKeyframes: vi.fn(), recOpenFile: vi.fn().mockResolvedValue(undefined), recReveal: vi.fn(), recTrim: vi.fn() }));
vi.mock("@/lib/api/rec", () => api);
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ close: vi.fn() }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const data = { path: "/test/recording.mp4", name: "recording.mp4", bytes: 100 };
describe("recording preview failure feedback", () => {
  it("reports an index error instead of claiming the recording is too short", async () => {
    api.recKeyframes.mockRejectedValueOnce(new Error("索引读取失败"));
    render(<RecPreview data={data} />);
    expect(await screen.findByText("索引读取失败")).toBeTruthy();
    expect(screen.getByText("无法读取裁剪时间轴")).toBeTruthy();
    expect(screen.queryByText(/录制太短/)).toBeNull();
  });
  it("offers the system player after a video error", async () => {
    api.recKeyframes.mockResolvedValueOnce({ durationMs: 10000, keyframesMs: [0, 1000, 10000] });
    const { container } = render(<RecPreview data={data} />);
    fireEvent.error(container.querySelector("video")!);
    fireEvent.click(screen.getByRole("button", { name: "用系统播放器打开" }));
    await waitFor(() => expect(api.recOpenFile).toHaveBeenCalledWith(data.path));
    expect(screen.getByRole("alert").textContent).toContain("应用内预览无法播放");
  });
  it("reports a rejected play request", async () => {
    api.recKeyframes.mockResolvedValueOnce({ durationMs: 10000, keyframesMs: [0, 1000, 10000] });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValueOnce(new Error("decode failed"));
    const { container } = render(<RecPreview data={data} />);
    fireEvent.click(container.querySelector("video")!);
    expect(await screen.findByRole("button", { name: "用系统播放器打开" })).toBeTruthy();
  });
});
