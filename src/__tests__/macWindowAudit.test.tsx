import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { SearchBox } from "@/components/SearchBox";
import { HelpTabContent } from "@/components/settings/HelpTabContent";
import { useAppStore } from "@/stores/appStore";
import { getAppName } from "@/lib/api/app";
import { invoke } from "@tauri-apps/api/core";
import { activeConfiguredHotkey, configuredShortcutLabel, primaryModifierHeld, primaryShortcutLabel, toolShortcutLabel } from "@/lib/utils";

vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: vi.fn().mockResolvedValue("/Users/audit/Library/Application Support/com.pastepanda.app"),
  join: vi.fn(async (...parts: string[]) => parts.join("/")),
}));

beforeEach(() => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  useAppStore.setState({ searchKeyword: "", searchHistory: [] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("actual main search wiring", () => {
  it.each([{ metaKey: true }, { ctrlKey: true }])("focuses the real input with %j + F", modifier => {
    render(<SearchBox />);
    fireEvent.keyDown(window, { key: "f", ...modifier });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "搜索剪贴板内容" }));
    expect(screen.getByPlaceholderText(/搜索剪贴板…\s+Command\+F/)).toBeTruthy();
  });
  it.each(["dialog-backdrop", "shortcut-overlay", "z-confirm"])("does not steal focus from %s", className => {
    render(<><SearchBox /><div className={className}><input aria-label="modal editor" /></div></>);
    const editor = screen.getByRole("textbox", { name: "modal editor" });
    editor.focus();
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(document.activeElement).toBe(editor);
  });
  it.each([{ shiftKey: true }, { altKey: true }, { isComposing: true }])("does not intercept another chord or IME: %j", flags => {
    render(<SearchBox />);
    fireEvent.keyDown(window, { key: "f", metaKey: true, ...flags });
    expect(document.activeElement).not.toBe(screen.getByRole("textbox"));
  });
  it("releases its window listener after unmount", () => {
    const view = render(<SearchBox />);
    view.unmount();
    const event = new KeyboardEvent("keydown", { key: "f", metaKey: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("native labels and disabled physical bindings", () => {
  it("keeps global Control physical, while window commands use Command", () => {
    expect(primaryShortcutLabel("shift+f")).toBe("Command+Shift+F");
    expect(primaryShortcutLabel("c", "Win32")).toBe("Ctrl+C");
    expect(configuredShortcutLabel("ctrl+alt+q", "")).toBe("Control+Option+Q");
    expect(toolShortcutLabel("diffedit", "ctrl+shift+d", {})).toBe("Command+Shift+D");
    expect(primaryModifierHeld({ ctrlKey: false, metaKey: true })).toBe(true);
  });
  it.each(["", "   "])("does not resurrect disabled %j bindings", value => {
    expect(activeConfiguredHotkey(value, "ctrl+alt+q")).toBeUndefined();
    expect(configuredShortcutLabel(value, "ctrl+alt+q")).toBe("已禁用");
    expect(toolShortcutLabel("screenrec", "ctrl+alt+r", { rec_hotkey: value })).toBeUndefined();
    expect(configuredShortcutLabel(undefined, "ctrl+alt+q")).toBe("Control+Option+Q");
  });
  it("renders the actual data directory and disabled help, with keyboard reachable headings", async () => {
    render(<HelpTabContent config={{ ...useAppStore.getState().config, hotkey: "", sequential_hotkey: "" }} appName="PastePanda" appVersion="7.2.10" />);
    expect(screen.getAllByText("已禁用").length).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: /常见问题/ }));
    fireEvent.click(screen.getByRole("button", { name: /数据存储在哪里/ }));
    await waitFor(() => expect(screen.getByText(/\/Users\/audit\/Library\/Application Support\/com.pastepanda.app\/clipboard.db/)).toBeTruthy());
    const shortcuts = screen.getByRole("button", { name: /快捷键速查/ });
    expect(shortcuts.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(shortcuts);
    expect(shortcuts.getAttribute("aria-expanded")).toBe("false");
    expect(shortcuts.nextElementSibling?.hasAttribute("inert")).toBe(true);
  });
  it("keeps Finder preview naming out of shared product branding, preserving other names", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("PastePanda AV1 Preview");
    expect(await getAppName()).toBe("PastePanda");
    vi.mocked(invoke).mockResolvedValueOnce("Custom Panda");
    expect(await getAppName()).toBe("Custom Panda");
  });
  it("guards the real App and card adapters against Control-only regressions", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    expect(app).toContain("ctrlKey: primaryModifierHeld(e)");
    // Command+H belongs to the native macOS Hide menu, so do not advertise it as help.
    expect(app).toContain('desc: "打开帮助", keys: configuredShortcutLabel("ctrl+h", "")');
    expect(configuredShortcutLabel("ctrl+h", "")).toBe("Control+H");
    expect(readFileSync("src/components/CardList.tsx", "utf8")).toContain("onItemClick(item.id, primaryModifierHeld(e), e.shiftKey)");
  });
});
