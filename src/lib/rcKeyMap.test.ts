import { describe, expect, it } from "vitest";
import { keyToVk, shouldForwardToRemote } from "./rcKeyMap";

describe("keyToVk", () => {
  it("字母与数字用物理 code", () => {
    expect(keyToVk({ code: "KeyA", key: "a" })).toBe(0x41);
    expect(keyToVk({ code: "KeyZ", key: "z" })).toBe(0x5a);
    expect(keyToVk({ code: "Digit1", key: "1" })).toBe(0x31);
    expect(keyToVk({ code: "Digit0", key: "0" })).toBe(0x30);
  });

  it("功能键与方向键", () => {
    expect(keyToVk({ code: "F1", key: "F1" })).toBe(0x70);
    expect(keyToVk({ code: "F12", key: "F12" })).toBe(0x7b);
    expect(keyToVk({ code: "ArrowUp", key: "ArrowUp" })).toBe(0x26);
    expect(keyToVk({ code: "Enter", key: "Enter" })).toBe(0x0d);
    expect(keyToVk({ code: "Escape", key: "Escape" })).toBe(0x1b);
  });

  it("修饰键左右可区分", () => {
    expect(keyToVk({ code: "ControlLeft", key: "Control" })).toBe(0xa2);
    expect(keyToVk({ code: "ShiftRight", key: "Shift" })).toBe(0xa1);
    expect(keyToVk({ code: "AltLeft", key: "Alt" })).toBe(0xa4);
  });

  it("小键盘", () => {
    expect(keyToVk({ code: "Numpad5", key: "5" })).toBe(0x65);
    expect(keyToVk({ code: "NumpadAdd", key: "+" })).toBe(0x6b);
  });

  it("无法映射返回 null", () => {
    expect(keyToVk({ code: "", key: "Dead" })).toBeNull();
    expect(keyToVk({ code: "Fn", key: "Fn" })).toBeNull();
  });

  it("不转发 Win 键", () => {
    expect(shouldForwardToRemote({ code: "MetaLeft", key: "Meta" })).toBe(false);
    expect(shouldForwardToRemote({ code: "KeyA", key: "a" })).toBe(true);
  });
});
