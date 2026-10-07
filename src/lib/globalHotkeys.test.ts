/**
 * globalHotkeys 守卫单测（规则 11.1 收口配套）。
 *
 * 钉两件事：
 * 1. 清单内容：12 个全局热键字段齐全、own 被排除、空值不掺进去——
 *    新增热键时改 globalHotkeys.ts 的 KEYS 这里就会钉住数量。
 * 2. 源码形状：settings 分区里不允许再出现手写的 `taken={[config.…]}` 内联数组
 *    （2026-10-05 审计的复发方式：新热键行抄旧行的清单，漏掉新字段单向收口）。
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globalHotkeysTaken } from "./globalHotkeys";

const fullConfig = {
  hotkey: "ctrl+alt+v",
  sequential_hotkey: "ctrl+alt+q",
  stack_toggle_hotkey: "ctrl+alt+k",
  stack_paste_hotkey: "ctrl+alt+p",
  quick_paste_hotkey: "alt+v",
  screenshot_hotkey: "ctrl+q",
  daily_note_hotkey: "ctrl+alt+d",
  todo_island_hotkey: "alt+t",
  rec_hotkey: "ctrl+alt+r",
  rec_pause_hotkey: "ctrl+alt+space",
  rec_stop_hotkey: "",
  rec_mark_hotkey: "ctrl+alt+m",
};

describe("globalHotkeysTaken：冲突清单唯一口径", () => {
  it("返回除 own 外的全部 12-1 个热键值", () => {
    const taken = globalHotkeysTaken(fullConfig, "rec_hotkey");
    expect(taken).toHaveLength(11);
    expect(taken).not.toContain("ctrl+alt+r");
    expect(taken).toContain("ctrl+alt+v");
    expect(taken).toContain("alt+t");
    expect(taken).toContain("ctrl+alt+space");
  });

  it("own 缺省时返回全部 12 个", () => {
    expect(globalHotkeysTaken(fullConfig)).toHaveLength(12);
  });

  it("空值字段映射为空串占位（HotkeyRecorder 对空串不判冲突）", () => {
    const taken = globalHotkeysTaken({ ...fullConfig, todo_island_hotkey: "" });
    expect(taken).toHaveLength(12);
    expect(taken).toContain("");
  });
});

describe("守卫：设置分区不许再手写内联 taken 清单", () => {
  const ROOT = join(process.cwd(), "src", "components", "settings");

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(e.name) && !e.name.includes(".test.")) out.push(p);
    }
    return out;
  }

  it(" HotkeyRecorder 的 taken 一律来自 globalHotkeysTaken", () => {
    const offenders = walk(ROOT)
      .map((f) => ({ f, src: readFileSync(f, "utf8") }))
      .filter(({ src }) => /taken=\{\[/.test(src))
      .map(({ f }) => f);
    expect(offenders).toEqual([]);
  });
});
