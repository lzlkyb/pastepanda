/**
 * 🔴 批次③（2026-10-24）：常驻悬浮窗入口必须有 ErrorBoundary 兜底。
 *
 * 这四个窗口（远程协助申请卡 / 栈浮标 / 待办岛 / 长截图状态窗）生命周期贯穿
 * 整个应用会话，且没有 ErrorBoundary 时渲染期抛错 = 白屏死掉，只能重启应用。
 * 其余入口（main / popup / editor / quickpaste / rc / rec 系列 / screenshot）都已包了——
 * 这四个是遗漏。改前此用例为红。
 *
 * 静态守卫（规则 23 ②）：入口文件不渲染组件树，断言源码里包了 ErrorBoundary。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const entries = [
  "rcask-main.tsx",
  "stackhud-main.tsx",
  "todoisland-main.tsx",
  "longshot-main.tsx",
] as const;

describe("批次③：常驻悬浮窗入口必须有 ErrorBoundary", () => {
  it.each(entries)("%s 包裹 <ErrorBoundary>（崩了白屏只能重启应用）", (entry) => {
    const src = readFileSync(
      fileURLToPath(new URL(`../${entry}`, import.meta.url)),
      "utf-8",
    );
    expect(
      src.includes("<ErrorBoundary"),
      `${entry} 缺少 ErrorBoundary 包裹：常驻悬浮窗渲染崩溃会白屏且无法自恢复`,
    ).toBe(true);
  });
});
