/**
 * 会话态「顶栏高度」单一真相守卫（2026-09-28，方案 A 落地，规则 11.1）。
 *
 * # 为什么存在
 *
 * `rc_fit_window_to_video`（Rust）把窗口高拆成「顶栏 chrome + 内容区」来算缩放比，
 * 而顶栏的高写在 CSS 里。两处原本各写一个数：CSS 侧 `.viewTop` 靠 padding 撑出来
 * 的 ~35px，Rust 侧 `SESSION_CHROME_H = 36.0` 还按「viewShell 上下边框各 1」在算
 * ——那对边框 2026-09-27 方案 A 就删了。差 1~2px 的现象是「适应档零黑边」偶尔
 * 还留一条细缝，且没有任何报错，只能靠断言钉住。
 *
 * # 守什么
 *
 * ① CSS 的 `--rc-session-chrome-h` 与 Rust 的 `SESSION_CHROME_H` 是同一个数；
 * ② `.viewTop` 的高与 `.capZone` 的 top 都吃这个变量（不许再写死字面量）；
 * ③ 全屏态顶栏退场 ⇒ 胶囊贴屏幕顶缘（`.capZoneFs { top: 0 }` 在场）。
 *
 * 改任一处的数字而不改另一处 = 这条红。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(
  join(process.cwd(), "src", "components", "rc", "RemoteComputer.module.css"),
  "utf8",
);
const RS = readFileSync(join(process.cwd(), "src-tauri", "src", "commands", "rc.rs"), "utf8");

function block(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = CSS.match(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`找不到规则块 ${selector}`);
  return m[1];
}

describe("会话顶栏高度：CSS 与 Rust 单一真相", () => {
  const cssPx = Number(CSS.match(/--rc-session-chrome-h:\s*(\d+(?:\.\d+)?)px/)?.[1] ?? NaN);
  const rustPx = Number(RS.match(/const SESSION_CHROME_H:\s*f64\s*=\s*(\d+(?:\.\d+)?)/)?.[1] ?? NaN);

  it("两处都能解析出数字（改动量写法时先更新本测试的取值口径）", () => {
    expect(Number.isFinite(cssPx), "CSS 里找不到 --rc-session-chrome-h: Npx").toBe(true);
    expect(Number.isFinite(rustPx), "rc.rs 里找不到 SESSION_CHROME_H: f64 = N").toBe(true);
  });

  it("🔴 CSS 变量 === Rust SESSION_CHROME_H（窗口态「适应档零黑边」的算式两边同源）", () => {
    expect(cssPx).toBe(rustPx);
  });

  it(".viewTop 的高与 .capZone 的 top 都走变量，不再各写一个像素字面量", () => {
    expect(block(".viewTop")).toMatch(/height:\s*var\(--rc-session-chrome-h/);
    expect(block(".capZone")).toMatch(/top:\s*var\(--rc-session-chrome-h/);
  });

  it("方案 A：全屏态顶栏整条退场 ⇒ 胶囊贴屏幕顶缘（.capZoneFs top:0）", () => {
    expect(block(".capZoneFs")).toMatch(/top:\s*0/);
  });
});
