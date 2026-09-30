/**
 * rcKeyMode / rcImeGuard 判据守卫（乙-①，2026-09-30）。
 *
 * 钉的是两条会「说谎」的表：
 * - 候选期间漏发放行 ⇒ 拼音字母逐个打进对方机器（C5 原样复发）；
 * - 直传模式把选字字符串发出去 ⇒ 一次会话里混用两种注入语义，比打不出中文更糟。
 */
import { describe, expect, it } from "vitest";
import {
  imeIntercepted,
  rcImeCommitOf,
  rcKeyModeFromConfig,
  rcKeyModeLabel,
  rcKeyModeOf,
} from "./rcKeyMode";

describe("rcKeyModeOf / 读偏好", () => {
  it("只认 direct，其余（缺键 / 脏值 / undefined）一律回默认档 type", () => {
    expect(rcKeyModeOf("direct")).toBe("direct");
    expect(rcKeyModeOf("type")).toBe("type");
    expect(rcKeyModeOf(undefined)).toBe("type");
    expect(rcKeyModeOf("auto")).toBe("type");
    expect(rcKeyModeFromConfig({ rc_key_mode: "direct" })).toBe("direct");
    // 旧配置没有这个键 ⇒ 默认打字（升级后中文照旧能打）
    expect(rcKeyModeFromConfig({})).toBe("type");
    expect(rcKeyModeFromConfig(null)).toBe("type");
  });

  it("胶囊读数是两个字（装得进 34px 高的那一行）", () => {
    expect(rcKeyModeLabel("type")).toHaveLength(2);
    expect(rcKeyModeLabel("direct")).toHaveLength(2);
  });
});

describe("imeIntercepted（候选期间的键一律不发）", () => {
  it("compositionstart 已起闸 ⇒ 之后每一键都拦", () => {
    expect(imeIntercepted({ key: "a", keyCode: 65 }, true)).toBe(true);
  });

  it("事件自己承认在组合中 ⇒ 拦", () => {
    expect(imeIntercepted({ key: "a", isComposing: true }, false)).toBe(true);
  });

  it("🔴 中文 IME 的第一颗键：Windows 报成 Process / keyCode 229，此时 compositionstart 可能还没到", () => {
    expect(imeIntercepted({ key: "Process", keyCode: 229 }, false)).toBe(true);
    expect(imeIntercepted({ key: "p", keyCode: 229 }, false)).toBe(true);
    expect(imeIntercepted({ key: "Process" }, false)).toBe(true);
  });

  it("正常按键（没在候选里）放行——否则键盘整个废掉", () => {
    expect(imeIntercepted({ key: "a", keyCode: 65, isComposing: false }, false)).toBe(false);
    expect(imeIntercepted({ key: "Enter", keyCode: 13 }, false)).toBe(false);
  });
});

describe("rcImeCommitOf（待拍板 ①：打字模式发字符串、直传不发）", () => {
  it("打字模式：选字结果整串发", () => {
    expect(rcImeCommitOf("type", "熊猫")).toBe("熊猫");
  });

  it("直传模式：什么都不发（扫描码语义下没有「字符」）", () => {
    expect(rcImeCommitOf("direct", "熊猫")).toBeNull();
  });

  it("空串与纯换行不发——那正是「选字的 Enter 被当成回车」要拦的那一类", () => {
    expect(rcImeCommitOf("type", "")).toBeNull();
    expect(rcImeCommitOf("type", "\n")).toBeNull();
    expect(rcImeCommitOf("type", undefined)).toBeNull();
  });
});
