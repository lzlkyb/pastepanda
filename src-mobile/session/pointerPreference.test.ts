import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POINTER_MODES, type PointerMode } from "./pointerModes";
import { readPointerPreference, savePointerPreference } from "./pointerPreference";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

it.each(Object.keys(POINTER_MODES) as PointerMode[])("设置和会话共用 %s 偏好", mode => {
  savePointerPreference(mode);
  expect(readPointerPreference()).toBe(mode);
});

it("缺失、非法或读取受限的偏好回到推荐触控板", () => {
  expect(readPointerPreference()).toBe("trackpad");
  localStorage.setItem("pastepanda-mobile-pointer-mode", "toString");
  expect(readPointerPreference()).toBe("trackpad");
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  expect(readPointerPreference()).toBe("trackpad");
});

it("保存失败向可见调用方抛出，不能伪报已保存", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  expect(() => savePointerPreference("pad")).toThrow("blocked");
});
