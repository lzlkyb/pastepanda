import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { persistEditorSource } from "@/lib/editorSource";
import { useCloseSave } from "@/components/editors/fullscreen/useCloseSave";
import { useAutoSaveFile } from "@/components/editors/fullscreen/useAutoSaveFile";
import { useDocumentSaveAs } from "@/components/editors/fullscreen/useDocumentSaveAs";
import { resolveFullscreenType } from "@/components/editors/fullscreen/registry";
import type { FileWatch } from "@/components/editors/useFileWatch";

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), ask: vi.fn() }));
const writeClipboard = vi.fn();
const checkNow = vi.fn(async () => false);
const markSynced = vi.fn(async () => {});
const watch = { checkNow, markSynced, externalChanged: false } as unknown as FileWatch;
const saveUntitled = vi.fn(async () => false);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  writeClipboard.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: writeClipboard } });
  vi.mocked(save).mockResolvedValue("/tmp/panda-audit.json");
  saveUntitled.mockResolvedValue(false);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("editor save destinations and close safety", () => {
  it("saves a tool draft to clipboard without updating a nonexistent history row", async () => {
    expect(await persistEditorSource("tool-json-123", "audit")).toBe("clipboard");
    expect(writeClipboard).toHaveBeenCalledWith("audit");
    expect(invoke).not.toHaveBeenCalled();
  });
  it("preserves history card save semantics", async () => {
    expect(await persistEditorSource("history-123", "audit")).toBe("history");
    expect(invoke).toHaveBeenCalledWith("update_history", { id: "history-123", text: "audit" });
    expect(writeClipboard).not.toHaveBeenCalled();
  });
  it("keeps failed clipboard saves rejected", async () => {
    writeClipboard.mockRejectedValueOnce(new Error("denied"));
    await expect(persistEditorSource("tool-json-123", "audit")).rejects.toThrow("denied");
    expect(invoke).not.toHaveBeenCalled();
  });
  it("does not autosave tool drafts to either clipboard or database", async () => {
    vi.useFakeTimers();
    const state = vi.fn();
    renderHook(() => useAutoSaveFile({ enabled: true, text: "new", baseline: "old",
      effectiveSourceId: "tool-json-123", currentFilePath: null, fileWatch: watch,
      setIsSaving: state, setInitialContent: state, setIsDirty: state, setAutoSaveError: state }));
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(invoke).not.toHaveBeenCalled();
    expect(writeClipboard).not.toHaveBeenCalled();
    expect(state).not.toHaveBeenCalled();
  });
  it("save-and-close on tool draft uses clipboard and waits for success", async () => {
    const { result } = renderHook(() => useCloseSave({ effectiveSourceId: "tool-json-123",
      currentFilePath: null, text: "audit", fileWatch: watch, saveUntitled }));
    expect(await result.current()).toBe(true);
    expect(writeClipboard).toHaveBeenCalledWith("audit");
    expect(invoke).not.toHaveBeenCalled();
    writeClipboard.mockRejectedValueOnce(new Error("denied"));
    expect(await result.current()).toBe(false);
  });
  it.each([null, "history-123"])("does not close if newer text arrives while saving source %s", async (source) => {
    const gate = deferred();
    vi.mocked(invoke).mockImplementationOnce(() => gate.promise);
    const { result, rerender } = renderHook(({ text }) => useCloseSave({ effectiveSourceId: source,
      currentFilePath: "/tmp/panda-audit.json", text, fileWatch: watch, saveUntitled }),
    { initialProps: { text: "v1" } });
    const pending = result.current();
    await act(async () => { await Promise.resolve(); });
    rerender({ text: "v2" });
    gate.resolve();
    expect(await pending).toBe(false);
  });
  it("requires successful save-as for untitled save-and-close", async () => {
    const { result } = renderHook(() => useCloseSave({ effectiveSourceId: null,
      currentFilePath: null, text: "audit", fileWatch: watch, saveUntitled }));
    expect(await result.current()).toBe(false);
    expect(saveUntitled).toHaveBeenCalledOnce();
    saveUntitled.mockResolvedValueOnce(true);
    expect(await result.current()).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });
});

function saveAsOptions() {
  return { text: "v1", fileName: "audit.json", spec: resolveFullscreenType("json"),
    latestText: { current: "v1" }, markSynced,
    setCurrentFilePath: vi.fn(), setEffectiveSourceId: vi.fn(), setFileName: vi.fn(),
    setInitialContent: vi.fn(), setIsDirty: vi.fn(), setAutoSaveError: vi.fn(), notify: vi.fn() };
}
describe("save-as identity and draft safety", () => {
  it("switches destination from card/clipboard to selected file", async () => {
    const opts = saveAsOptions();
    const { result } = renderHook(() => useDocumentSaveAs(opts));
    expect(await result.current()).toBe(true);
    expect(invoke).toHaveBeenCalledWith("write_text_file_full", { path: "/tmp/panda-audit.json", text: "v1" });
    expect(opts.setEffectiveSourceId).toHaveBeenCalledWith(null);
    expect(opts.setCurrentFilePath).toHaveBeenCalledWith("/tmp/panda-audit.json");
    expect(opts.setIsDirty).toHaveBeenCalledWith(false);
  });
  it("cancel leaves the original target and draft intact", async () => {
    vi.mocked(save).mockResolvedValueOnce(null);
    const opts = saveAsOptions();
    const { result } = renderHook(() => useDocumentSaveAs(opts));
    expect(await result.current()).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    expect(opts.setEffectiveSourceId).not.toHaveBeenCalled();
    expect(opts.setInitialContent).not.toHaveBeenCalled();
  });
  it("write failure keeps the draft open and reports failure", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("full disk"));
    const opts = saveAsOptions();
    const { result } = renderHook(() => useDocumentSaveAs(opts));
    expect(await result.current()).toBe(false);
    expect(opts.setInitialContent).not.toHaveBeenCalled();
    expect(opts.notify).toHaveBeenCalledWith("保存失败: full disk", "error");
  });
  it("a newer edit while save-as is pending remains dirty and cannot be closed", async () => {
    const gate = deferred();
    vi.mocked(invoke).mockImplementationOnce(() => gate.promise);
    const opts = saveAsOptions();
    const { result } = renderHook(() => useDocumentSaveAs(opts));
    const pending = result.current();
    await act(async () => { await Promise.resolve(); });
    opts.latestText.current = "v2";
    gate.resolve();
    expect(await pending).toBe(false);
    expect(opts.setInitialContent).toHaveBeenCalledWith("v1");
    expect(opts.setIsDirty).toHaveBeenCalledWith(true);
  });
});

vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/editors/useFileWatch", () => ({ useFileWatch: () => watch }));
import { useDocumentFile } from "@/components/editors/fullscreen/useDocumentFile";
function documentOptions(sourceId: string | null) {
  return { sourceId, initContent: "v1", initFilePath: null, initLanguage: null,
    spec: resolveFullscreenType("json"), active: true, autoSaveEnabled: true, onFatal: vi.fn() };
}
describe("document model save integration", () => {
  it("tool fullscreen keeps edited text dirty until explicit clipboard save", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useDocumentFile(documentOptions("tool-json-123")));
    act(() => result.current.handleDocChange("v2"));
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(result.current.isDirty).toBe(true);
    expect(result.current.autoSaveError).toBe(false);
    expect(writeClipboard).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => { await result.current.handleSave(); });
    expect(writeClipboard).toHaveBeenCalledWith("v2");
    expect(result.current.isDirty).toBe(false);
  });
  it("after save-as, subsequent manual save targets the file, not the original card", async () => {
    const { result } = renderHook(() => useDocumentFile(documentOptions("history-123")));
    await act(async () => { expect(await result.current.handleSaveAs()).toBe(true); });
    expect(result.current.effectiveSourceId).toBeNull();
    act(() => result.current.handleDocChange("v2"));
    await act(async () => { await result.current.handleSave(); });
    expect(invoke).toHaveBeenCalledWith("write_text_file_full", { path: "/tmp/panda-audit.json", text: "v2" });
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "update_history")).toBe(false);
    expect(result.current.isDirty).toBe(false);
  });
  it("untitled save-and-close cancelled in system dialog retains unsaved draft", async () => {
    const { result } = renderHook(() => useDocumentFile(documentOptions(null)));
    act(() => result.current.handleDocChange("v2"));
    vi.mocked(save).mockResolvedValueOnce(null);
    await act(async () => { expect(await result.current.saveForClose()).toBe(false); });
    expect(result.current.isDirty).toBe(true);
    expect(result.current.text).toBe("v2");
    expect(invoke).not.toHaveBeenCalled();
  });
});

import { useEditorCore } from "@/components/editors/useEditorCore";
import { makeToolItem } from "@/lib/toolEditors";
describe("small editor save snapshot", () => {
  it.each(["tool-json-123", "history-123"])("does not dismiss a newer edit while saving %s", async (id) => {
    const gate = deferred();
    if (id.startsWith("tool-")) writeClipboard.mockImplementationOnce(() => gate.promise);
    else vi.mocked(invoke).mockImplementationOnce(() => gate.promise);
    const item = { ...makeToolItem("json", "v1"), id };
    const register = vi.fn();
    const { result } = renderHook(() => useEditorCore(item, register));
    act(() => result.current.pushHistory("v2"));
    const pending = result.current.save();
    act(() => result.current.pushHistory("v3"));
    await act(async () => { gate.resolve(); expect(await pending).toBe(false); });
    expect(result.current.text).toBe("v3");
    expect(result.current.isDirty()).toBe(true);
    if (id.startsWith("tool-")) expect(writeClipboard).toHaveBeenCalledWith("v2");
    else expect(invoke).toHaveBeenCalledWith("update_history", { id, text: "v2" });
  });
});
