import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { SettingsCluster } from "@/components/recsel/RecSettingsCluster";
import { AudioToggles } from "@/components/recsel/RecAudioToggles";
import { PreviewBar } from "@/components/recsel/RecOverlayParts";
import { RecPreview } from "@/components/recsel/RecPreview";
import { RecRecentList } from "@/components/recsel/RecRecentList";
import { useRecSelectMouse, type Phase } from "@/hooks/useRecSelectMouse";
import { useState } from "react";
import { useRecAudioCheck } from "@/hooks/useRecAudioCheck";
import { useRecGifExport } from "@/hooks/useRecGifExport";
import { useRecTrimTask } from "@/hooks/useRecTrimTask";
import { recQualityOf } from "@/lib/recQuality";

const api = vi.hoisted(() => ({ recCheckAudio: vi.fn(), recKeyframes: vi.fn(), recOpenFile: vi.fn(), recOpenPreview: vi.fn(), recReveal: vi.fn(), recTrim: vi.fn(), recTrimStatus: vi.fn(), recTrimCancel: vi.fn(), recListFiles: vi.fn(), recDeleteFile: vi.fn(), recGifStart: vi.fn(), recGifStatus: vi.fn(), recGifCancel: vi.fn() }));
vi.mock("@/lib/api/rec", () => api);
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn(() => Promise.resolve([{ x: 0, y: 0, w: 1280, h: 720 }])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ close: vi.fn().mockResolvedValue(undefined) }) }));
vi.mock("@/stores/appStore", () => ({ useAppStore: (fn: (s: unknown) => unknown) => fn({ config: { rec_hotkey: "Ctrl+Alt+R" } }) }));
const audio = { open: false, onToggle: vi.fn(), flipBelow: false, quality: recQualityOf("high"), onQuality: vi.fn(), sysAudio: true, micAudio: false, onSys: vi.fn(), onMic: vi.fn() };
const data = { path: "/recording.mp4", name: "recording.mp4", bytes: 100 };
/** §06：长尾动作收进 ⋯ 菜单，菜单关着时（hidden）按钮不在读屏树里——先打开再点。 */
const openMenus = async () => {
  const triggers = await screen.findAllByRole("button", { name: "更多操作" });
  triggers.forEach((b) => fireEvent.click(b));
};
beforeEach(() => { vi.clearAllMocks(); api.recTrimStatus.mockResolvedValue({ running: false, percent: 0, donePath: null, error: null }); api.recGifStatus.mockResolvedValue({ running: false, percent: 0, donePath: null, error: null }); api.recKeyframes.mockResolvedValue({ durationMs: 10000, keyframesMs: [0, 1000, 5000, 10000] }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("office recording clarity", () => {
  it("keeps an intentional drag inside a maximized window as the chosen region", async () => {
    const geometry = { originX: 0, originY: 0, width: 1280, height: 720 };
    const { result } = renderHook(() => { const [phase, setPhase] = useState<Phase>("preview"); return { phase, ...useRecSelectMouse(phase, setPhase, geometry) }; });
    await act(async () => {});
    const event = (x: number, y: number) => ({ target: document.body, clientX: x, clientY: y }) as unknown as React.MouseEvent;
    act(() => result.current.onMouseDown(event(100, 100)));
    act(() => result.current.onMouseMove(event(300, 250)));
    act(() => result.current.onMouseUp());
    expect(result.current.rect).toEqual({ x: 100, y: 100, w: 200, h: 150 });
    expect(result.current.rectFromWindow).toBe(false);
  });
  it("keeps both audio sources and the quality picker reachable without opening a panel", () => {
    const toggles = { sysAudio: true, micAudio: false, onSys: vi.fn(), onMic: vi.fn() };
    render(<><AudioToggles {...toggles} /><SettingsCluster {...audio} /></>);
    // §5.1：文字只留音源名，状态由 aria-pressed + 实心/空心点承担（不再有「开 / 关」两字）
    fireEvent.click(screen.getByRole("button", { name: "电脑声音" }));
    fireEvent.click(screen.getByRole("button", { name: "麦克风" }));
    expect(toggles.onSys).toHaveBeenCalledOnce(); expect(toggles.onMic).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: /画质/ })).toBeTruthy();
  });
  it("keeps the fixed-position note out of the permanent row and behind the `?`", () => {
    const bar = { ...audio, settingsOpen: false, onToggleSettings: vi.fn(), target: { text: "400 × 300", kind: "window" as const }, hasWindowTarget: true, onReleaseTarget: vi.fn(), screenCssH: 720, onStart: vi.fn(), onCancel: vi.fn() };
    const { rerender } = render(<PreviewBar {...bar} helpOpen={false} onToggleHelp={vi.fn()} />);
    // §5.1：常驻教学行删掉后，条上不该再出现这句
    expect(screen.queryByText(/按屏幕位置录制/)).toBeNull();
    rerender(<PreviewBar {...bar} helpOpen onToggleHelp={vi.fn()} />);
    expect(screen.getByText(/按屏幕位置录制/)).toBeTruthy();
  });
  it("provides a visible play button and keyboard operable trim bounds", async () => {
    render(<RecPreview data={data} />);
    expect(screen.getByRole("button", { name: "播放" })).toBeTruthy();
    const start = await screen.findByRole("slider", { name: "裁剪起点" });
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
    fireEvent.change(start, { target: { value: "1000" } });
    fireEvent.keyDown(start, { key: "ArrowRight" });
    expect((start as HTMLInputElement).value).toBe("5000");
    expect(screen.getByRole("button", { name: /另存裁剪|保存裁剪/ }).hasAttribute("disabled")).toBe(false);
  });
  it("does not hide a directory read failure behind the empty state", async () => {
    api.recListFiles.mockRejectedValueOnce(new Error("目录不可访问"));
    render(<RecRecentList />);
    expect((await screen.findByRole("alert")).textContent).toContain("目录不可访问");
    expect(screen.queryByText("还没有录制。")).toBeNull();
    api.recListFiles.mockResolvedValueOnce([]);
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
  it("exposes a GIF status failure and a recovery action", async () => {
    api.recListFiles.mockResolvedValueOnce([{ ...data, durationMs: 10000 }]);
    api.recGifStart.mockResolvedValueOnce(undefined);
    api.recGifStatus.mockResolvedValueOnce({ running: false, percent: 0, donePath: null, error: null })
      .mockRejectedValue(new Error("查询中断"));
    render(<RecRecentList />);
    await openMenus();
    const start = await screen.findByRole("button", { name: /^(导出 )?GIF$/ });
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
    fireEvent.click(start);
    expect((await screen.findByRole("alert", {}, { timeout: 3000 })).textContent).toContain("查询中断");
    expect(screen.getByRole("button", { name: "重新查询 GIF" })).toBeTruthy();
  });
  it("offers a global recovery when initial GIF discovery cannot identify the running source", async () => {
    api.recListFiles.mockResolvedValueOnce([
      { ...data, durationMs: 10000 },
      { ...data, path: "/second.mp4", name: "second.mp4", durationMs: 10000 },
    ]);
    api.recGifStatus.mockRejectedValue(new Error("发现查询中断"));
    render(<RecRecentList />);
    const retry = await screen.findByRole("button", { name: "重新查询 GIF 任务" });
    expect(screen.getByRole("alert").textContent).toContain("无法确认");
    await openMenus();
    expect(screen.getAllByRole("button", { name: "导出 GIF" }).every(button => button.hasAttribute("disabled"))).toBe(true);
    expect(api.recGifStart).not.toHaveBeenCalled();
    api.recGifStatus.mockImplementation(async (source: string) => ({
      running: source === data.path, percent: 42, donePath: null, error: null,
    }));
    fireEvent.click(retry);
    expect(await screen.findByRole("button", { name: "取消导出 GIF" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: "重新查询 GIF 任务" })).toBeNull());
  });
  it("can recover an already running GIF after a start request is rejected", async () => {
    api.recListFiles.mockResolvedValueOnce([{ ...data, durationMs: 10000 }]);
    api.recGifStart.mockRejectedValueOnce(new Error("已有 GIF 导出在进行"));
    render(<RecRecentList />);
    await openMenus();
    const start = await screen.findByRole("button", { name: "导出 GIF" });
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
    fireEvent.click(start);
    const retry = await screen.findByRole("button", { name: "重新查询 GIF" });
    api.recGifStatus.mockResolvedValue({ running: true, percent: 42, donePath: null, error: null });
    fireEvent.click(retry);
    expect(await screen.findByRole("button", { name: "取消导出 GIF" })).toBeTruthy();
  });
  it("disables every source while one GIF task has an unknown status", async () => {
    api.recListFiles.mockResolvedValueOnce([
      { ...data, durationMs: 10000 },
      { ...data, path: "/second.mp4", name: "second.mp4", durationMs: 10000 },
    ]);
    api.recGifStart.mockRejectedValueOnce(new Error("启动响应中断"));
    render(<RecRecentList />);
    await openMenus();
    const starts = await screen.findAllByRole("button", { name: "导出 GIF" });
    await waitFor(() => expect(starts[0].hasAttribute("disabled")).toBe(false));
    fireEvent.click(starts[0]);
    await screen.findByRole("alert");
    expect(starts[1].hasAttribute("disabled")).toBe(true);
    fireEvent.click(starts[1]);
    expect(api.recGifStart).toHaveBeenCalledTimes(1);
  });
  it("keeps the saved HUD result until the user closes it", () => {
    const entry = readFileSync("src/rec-hud-main.tsx", "utf8");
    expect(entry).not.toMatch(/setInterval|setTimeout/);
  });
  it("blocks starting when the requested microphone is unavailable", async () => {
    api.recCheckAudio.mockResolvedValueOnce({ sysAudio: true, micAudio: false, warnings: ["没有可用麦克风"] });
    const ready = vi.fn();
    const { result } = renderHook(() => useRecAudioCheck(true, true));
    await act(async () => result.current.checkAudio(ready));
    expect(ready).not.toHaveBeenCalled();
    expect(result.current.audioError).toContain("没有可用麦克风");
  });
  it("does not start after the user cancels a pending audio check", async () => {
    let checked!: (result: { sysAudio: boolean; micAudio: boolean; warnings: string[] }) => void;
    api.recCheckAudio.mockImplementationOnce(() => new Promise((resolve) => { checked = resolve; }));
    const ready = vi.fn();
    const { result } = renderHook(() => useRecAudioCheck(true, false));
    let pending!: Promise<void>;
    act(() => { pending = result.current.checkAudio(ready); });
    act(() => result.current.cancelCheck());
    await act(async () => { checked({ sysAudio: true, micAudio: true, warnings: [] }); await pending; });
    expect(ready).not.toHaveBeenCalled();
  });
  it("keeps the frozen trim range when Escape is pressed during saving", async () => {
    api.recTrim.mockImplementationOnce(() => new Promise(() => {}));
    render(<RecPreview data={data} />);
    const start = screen.getByRole("slider", { name: "裁剪起点" });
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
    fireEvent.change(start, { target: { value: "1000" } });
    fireEvent.click(screen.getByRole("button", { name: "另存裁剪" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect((start as HTMLInputElement).value).toBe("1000");
    expect(start.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Esc 不会取消保存/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "关闭，后台继续保存" })).toBeTruthy();
  });
  it("offers the actual GIF output after a finished export", async () => {
    api.recListFiles.mockResolvedValueOnce([{ ...data, durationMs: 10000 }]);
    api.recGifStatus.mockResolvedValue({ running: false, percent: 100, donePath: "/recording.gif", error: null });
    api.recOpenFile.mockResolvedValueOnce(undefined);
    render(<RecRecentList />);
    fireEvent.click(await screen.findByRole("button", { name: "打开 GIF" }));
    await waitFor(() => expect(api.recOpenFile).toHaveBeenCalledWith("/recording.gif"));
  });
  it("ignores an old GIF discovery response after starting a new source", async () => {
    let oldResponse!: (value: { running: boolean; percent: number; donePath: null; error: null }) => void;
    api.recGifStatus.mockImplementationOnce(() => new Promise((resolve) => { oldResponse = resolve; }));
    api.recGifStart.mockResolvedValueOnce(undefined);
    const paths = ["/old.mp4"];
    const { result } = renderHook(() => useRecGifExport(paths));
    await act(async () => result.current.start("/new.mp4"));
    await act(async () => oldResponse({ running: true, percent: 30, donePath: null, error: null }));
    expect(result.current.task?.source).toBe("/new.mp4");
  });
  it("does not overlap trim status requests from the same generation", async () => {
    api.recTrimStatus.mockImplementationOnce(() => new Promise(() => {}));
    const { result } = renderHook(() => useRecTrimTask("/recording.mp4"));
    await act(async () => result.current.query());
    expect(api.recTrimStatus).toHaveBeenCalledTimes(1);
  });
});
