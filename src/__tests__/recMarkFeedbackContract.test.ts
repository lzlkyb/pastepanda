/**
 * rec-marked 事件两端同名守卫（2026-10-24 审查 R1）。
 *
 * 标记反馈的失败方式是「静默」：Rust 侧改名或删掉 emit、前端删掉监听，tsc 与
 * cargo 编译全都照绿，用户只是从此按标记热键没有回话。行为测试
 * （RecControlBar.test.tsx）mock 了事件层、盖不到这条跨语言字符串契约，
 * 只能靠源码对读钉住（先例：windowEntryErrorBoundary / clotheslineNativeContract）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("rec-marked 两端契约", () => {
  it("Rust 侧 emit 与前端 listen 用同一个事件名", () => {
    const rust = readFileSync("src-tauri/src/rec/session.rs", "utf8");
    const ts = readFileSync("src/hooks/useRecControlState.ts", "utf8");
    expect(rust, "session.rs 应 emit rec-marked").toMatch(/emit\(\s*"rec-marked"/);
    expect(ts, "useRecControlState 应监听 rec-marked").toContain('"rec-marked"');
  });
});
