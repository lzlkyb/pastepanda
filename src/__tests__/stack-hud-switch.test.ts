/**
 * 栈浮标开关守卫（2026-09-28）。
 *
 * 钉四条容易单独漂移的东西：
 * 1. **口径**：只有明确 `false` 才算关。缺省与脏值当开 —— 与 Rust
 *    `enabled_or_default` 必须同口径，错开的现象是「设置里开着、浮标死活不出来」，
 *    而两端各自查都查不出来。
 * 2. **关掉时零开销**：不推送、不显示，连那次 `pastePrecheck` 目标解析都不发
 *    （`hudStackModeEntered` 在解析前就 return）。
 * 3. **隐藏路径不受闸管**：关开关那一刻正显示的浮标靠 `hudDismiss` 收掉，
 *    它不能被判据挡住（规则 15.1：反馈与触发要同时在可见域内生效）。
 * 4. **收口**：消费方一律经 `isHudEnabled`，不许各自写 `!== false`；
 *    跨端键名与本仓 Rust 侧的 `ENABLED_KEY` 同字（规则 11.1 的守卫口径：
 *    第 4 个调用点若仍能自己写判据或写错键名，就说明还没收口）。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/stores/appStore";
import { isHudEnabled } from "@/lib/stack/types";
import {
  hudEnabled,
  hudDismiss,
  hudStackModeEntered,
  hudStackModeExited,
  hudPastedOk,
  hudAllDone,
} from "@/lib/stack/hudBridge";

function commands(): string[] {
  return vi.mocked(invoke).mock.calls.map((c) => c[0] as string);
}

function setSwitch(value: unknown) {
  useAppStore.setState((s) => ({
    config: { ...s.config, stack_hud_enabled: value as boolean },
  }));
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue({ success: true });
  useAppStore.setState({ stackMode: true, stackItems: [], stackPasted: 0, stackCollected: 0 });
});

describe("isHudEnabled 取值口径", () => {
  it("只有明确 false 才算关；缺省与脏值都当开", () => {
    expect(isHudEnabled(false)).toBe(false);
    expect(isHudEnabled(undefined)).toBe(true);
    expect(isHudEnabled(null)).toBe(true);
    expect(isHudEnabled(true)).toBe(true);
    expect(isHudEnabled("false")).toBe(true);
  });

  it("hudEnabled 读的就是这条口径（不是第二份实现）", () => {
    setSwitch(false);
    expect(hudEnabled()).toBe(false);
    setSwitch(true);
    expect(hudEnabled()).toBe(true);
    // 老用户后端没有这个键 → 缺省必须是开
    setSwitch(undefined);
    expect(hudEnabled()).toBe(true);
  });
});

describe("关掉开关：零推送、零显示", () => {
  it("开栈不推送也不显示（连目标解析那次 precheck 都不发）", async () => {
    setSwitch(false);
    await hudStackModeEntered();
    expect(commands()).toHaveLength(0);
  });

  it("粘贴成功 / 全部完毕都不再推状态", async () => {
    setSwitch(false);
    await hudPastedOk(2);
    hudAllDone();
    expect(commands().filter((c) => c === "stack_hud_update")).toHaveLength(0);
  });

  it("开着时照常推 —— 反面：少了这条，「永远不推」的退化实现也能过上面的用例", async () => {
    setSwitch(true);
    await hudPastedOk(2);
    expect(commands()).toContain("stack_hud_update");
  });

  it("开着时开栈会要求显示（重新打开后要能立刻补一次显示，靠的就是这条路径）", async () => {
    setSwitch(true);
    await hudStackModeEntered();
    expect(commands()).toContain("stack_hud_show");
    expect(commands()).toContain("stack_hud_update");
  });
});

describe("隐藏路径不受闸管", () => {
  it("关着时 hudDismiss 仍然发隐藏（关掉那一刻要收得掉）", () => {
    setSwitch(false);
    hudDismiss();
    expect(commands()).toContain("stack_hud_hide");
  });

  it("退出栈模式同理：隐藏照常，只是不推状态", () => {
    setSwitch(false);
    hudStackModeExited();
    expect(commands()).toContain("stack_hud_hide");
    expect(commands()).not.toContain("stack_hud_update");
  });
});

describe("收口守卫（规则 11.1）", () => {
  const read = (rel: string) =>
    readFileSync(resolve(__dirname, "../..", rel), "utf8").replace(/\r\n/g, "\n");

  it("消费方一律经 isHudEnabled，不各自写 !== false", () => {
    const consumers = [
      "src/components/settings/sections/HotkeySection.tsx",
      "src/components/TrayPopup.tsx",
      "src/lib/stack/hudBridge.ts",
    ];
    for (const file of consumers) {
      const src = read(file);
      if (!src.includes("stack_hud_enabled")) continue; // 该文件本就不碰这个键
      expect(src, `${file} 应经 isHudEnabled 判开关`).toContain("isHudEnabled(");
    }
    // 判据本身只有一份：除 types.ts（定义处）与 appStore（键定义）外，
    // 任何文件里都不该出现 `stack_hud_enabled !== false` 这种就地比较
    const offenders = [
      "src/App.tsx",
      "src/components/StackBanner.tsx",
      "src/lib/api/stack.ts",
      "src/lib/api/init.ts",
    ].filter((f) => read(f).includes("stack_hud_enabled !== false"));
    expect(offenders).toEqual([]);
  });

  it("跨端键名与 Rust 的 ENABLED_KEY 同字", () => {
    const rust = read("src-tauri/src/stack_hud.rs");
    const m = rust.match(/pub const ENABLED_KEY: &str = "([^"]+)"/);
    expect(m, "Rust 侧 ENABLED_KEY 常量不见了").not.toBeNull();
    expect(m![1]).toBe("stack_hud_enabled");
  });

  it("Rust 兜底闸口径与前端一致（缺省开：unwrap_or(true)）", () => {
    const rust = read("src-tauri/src/stack_hud.rs");
    expect(rust).toContain("v.and_then(|x| x.as_bool()).unwrap_or(true)");
  });
});
