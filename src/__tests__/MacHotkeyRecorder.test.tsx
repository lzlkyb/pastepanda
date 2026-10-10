import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { HotkeyRecorder } from "@/components/settings/HotkeyRecorder";
import { formatHotkey } from "@/lib/utils";
beforeEach(() => { vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("Mac shortcut recording", () => {
  it("uses platform labels", () => {
    expect(formatHotkey("meta+alt+k", "MacIntel")).toBe("Command + Option + K");
    expect(formatHotkey("meta+alt+k", "Win32")).toBe("Win + Alt + K");
  });
  it("records an Option-generated character as a physical shortcut", () => {
    const changed = vi.fn(); render(<HotkeyRecorder value="" onChange={changed} />);
    const button = screen.getByRole("button"); fireEvent.click(button);
    fireEvent.keyDown(button, { key: "å", code: "KeyA", altKey: true });
    expect(changed).toHaveBeenCalledWith("alt+a");
  });
  it("records Command+Shift+digit instead of punctuation", () => {
    const changed = vi.fn(); render(<HotkeyRecorder value="" onChange={changed} />);
    const button = screen.getByRole("button"); fireEvent.click(button);
    fireEvent.keyDown(button, { key: "!", code: "Digit1", metaKey: true, shiftKey: true });
    expect(changed).toHaveBeenCalledWith("shift+meta+1");
  });
  it("preserves Windows keyboard-layout letters", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    const changed = vi.fn(); render(<HotkeyRecorder value="" onChange={changed} />);
    const button = screen.getByRole("button"); fireEvent.click(button);
    fireEvent.keyDown(button, { key: "a", code: "KeyQ", ctrlKey: true });
    expect(changed).toHaveBeenCalledWith("ctrl+a");
  });
  it("recognizes an existing Command alias as a conflict", () => {
    const changed = vi.fn(); render(<HotkeyRecorder value="" taken={["Cmd+Shift+K"]} onChange={changed} />);
    const button = screen.getByRole("button"); fireEvent.click(button);
    fireEvent.keyDown(button, { key: "K", code: "KeyK", metaKey: true, shiftKey: true });
    expect(changed).not.toHaveBeenCalled(); expect(button.textContent).toContain("冲突");
  });
});
