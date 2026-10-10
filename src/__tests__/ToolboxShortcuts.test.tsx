import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { primarySearchShortcut, toolShortcutLabel } from "@/lib/utils";
import { ToolboxView } from "@/components/ToolboxView";
const state = vi.hoisted(() => ({ config: { sequential_hotkey: "ctrl+alt+q", rec_hotkey: "cmd+alt+g" } }));
vi.mock("@/stores/appStore", () => ({ useAppStore: (selector: (value: typeof state) => unknown) => selector(state) }));
vi.mock("@/components/recsel/RecRecentList", () => ({ RecRecentList: () => null }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); state.config.rec_hotkey = "cmd+alt+g"; });
describe("configured toolbox shortcut hints", () => {
  it("shows the configured Mac recording key and Command search hint", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    render(<ToolboxView handlers={{}} />);
    expect(screen.getByText("Command+Option+G")).toBeTruthy();
    expect(screen.getByPlaceholderText(/筛选工具…\s+Command\+F/)).toBeTruthy();
    expect(screen.queryByText("Ctrl+Alt+R")).toBeNull();
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(document.activeElement).toBe(screen.getByRole("searchbox"));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Command+Option+G" } });
    expect(screen.getByText("屏幕录制")).toBeTruthy();
  });
  it("does not advertise a disabled shortcut", () => {
    state.config.rec_hotkey = "";
    render(<ToolboxView handlers={{}} />);
    expect(screen.queryByText(/Command\+Option\+G|Ctrl\+Alt\+R/)).toBeNull();
    expect(toolShortcutLabel("screenrec", "ctrl+alt+r", { rec_hotkey: "" }, "MacIntel")).toBeUndefined();
  });
  it("lets a dialog retain Command+F instead of stealing its focus", () => {
    render(<><ToolboxView handlers={{}} /><div className="dialog-backdrop"><input aria-label="弹窗输入" /></div></>);
    const field = screen.getByLabelText("弹窗输入"); field.focus();
    fireEvent.keyDown(field, { key: "f", metaKey: true });
    expect(document.activeElement).toBe(field);
  });
  it("keeps Control distinct from Command and preserves Windows keys", () => {
    expect(toolShortcutLabel("screenrec", undefined, { rec_hotkey: "ctrl+alt+r" }, "MacIntel")).toBe("Control+Option+R");
    expect(toolShortcutLabel("screenrec", undefined, { rec_hotkey: "ctrl+alt+r" }, "Win32")).toBe("Ctrl+Alt+R");
    expect(primarySearchShortcut("Win32")).toBe("Ctrl+F");
  });
});
