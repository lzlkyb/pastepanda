/**
 * rec-marked 事件两端同名守卫（2026-10-24 审查 R1）。
 *
 * 标记反馈的失败方式是「静默」：Rust 侧改名或删掉 emit、前端删掉监听，tsc 与
 * cargo 编译全都照绿，用户只是从此按标记热键没有回话。行为测试
 * （RecControlBar.test.tsx）mock 了事件层、盖不到这条跨语言字符串契约，
 * 只能靠源码对读钉住（先例：windowEntryErrorBoundary / clotheslineNativeContract）。
 *
 * 🔴 平台双实现同改：rec::session 在 Windows 走 rec/session.rs、macOS 走
 * macos/rec_session.rs——PR #31 只改了前者，macOS CI 才红（E0061）。本守卫
 * 因此**两份实现都要钉**：只改一边，另一边这边就红。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("rec-marked 两端契约", () => {
  it("Rust 侧 emit 与前端 listen 用同一个事件名", () => {
    const rust = readFileSync("src-tauri/src/rec/session.rs", "utf8");
    const macos = readFileSync("src-tauri/src/macos/rec_session.rs", "utf8");
    const ts = readFileSync("src/hooks/useRecControlState.ts", "utf8");
    expect(rust, "rec/session.rs（Windows/Linux）应 emit rec-marked").toMatch(/emit\(\s*"rec-marked"/);
    expect(macos, "macos/rec_session.rs 应 emit rec-marked（平台双实现，别只改一边）").toMatch(/emit\(\s*"rec-marked"/);
    expect(ts, "useRecControlState 应监听 rec-marked").toContain('"rec-marked"');
  });
});
