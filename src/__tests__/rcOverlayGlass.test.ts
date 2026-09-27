/**
 * rc 会话浮层「半透明深玻璃」守卫（2026-09-27，视觉规范 §1 原则 1 修订的兑现）。
 *
 * # 不变量
 *
 * 压在**远端画面**上的浮层（会话胶囊 / HUD 面板 / 全屏 hotbar / 全屏键盘徽标）
 * 恒为半透明深玻璃、不随主题翻面——它们底下是不可控的对端内容（白纸或黑终端），
 * 可读性对赌的是画面而非本地主题。工作台面（侧栏 / hero / 卡片）则相反，必须
 * 跟随主题令牌（那条由 rcA2ThemeTokens.test.ts 守）。
 *
 * # 守什么
 *
 * ① **半透明**（0 < α < 1）：毛玻璃必须透出画面，谁把它改成实色就红；
 * ② **深底**（RGB 每通道 ≤ 30）：压白底文档时文字对比靠它，谁改成浅底就红
 *    （浮层上的文字是固定浅色，底一浅对比即崩——rcHudContrast.test.ts 的前提）。
 *
 * 不抄常量、直接读 CSS（同 rcHudContrast 的方法论）：改 CSS 不改测试 = 这条红。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSS = readFileSync(
  join(process.cwd(), "src", "components", "rc", "RemoteComputer.module.css"),
  "utf8",
);

/* 只认「行首 .sel { … }」的扁平规则块（与 rcHudContrast 同款极简解析）。 */
function block(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = CSS.match(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`找不到规则块 ${selector}`);
  return m[1];
}

/** 背景声明里的第一个 rgba()（渐变里的第一个色标也算——.fsBar 是深色渐变）。 */
function firstRgba(selector: string): [number, number, number, number] {
  const text = block(selector).match(/(?:^|[\s;])background:\s*([^;]+);/)?.[1] ?? "";
  const m = text.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/);
  if (!m) throw new Error(`${selector} 的 background 里找不到带 α 的 rgba()`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}

/** 被守的浮层：全部压在远端画面上（压本地窗口的横幅/抽屉走主题令牌，不在此列）。 */
const OVERLAYS: ReadonlyArray<[string, string]> = [
  [".capCapsule", "控端会话胶囊"],
  [".hudPanel", "HUD 连接详情面板"],
  [".fsBar", "全屏 hotbar（深色渐变）"],
  [".fsKbBadge", "全屏键盘捕获徽标"],
];

describe("会话浮层恒为半透明深玻璃（视觉规范 §1 原则 1）", () => {
  for (const [sel, label] of OVERLAYS) {
    it(`${label} ${sel}：半透明（0 < α < 1）且深底（RGB ≤ 30）`, () => {
      const [r, g, b, a] = firstRgba(sel);
      expect(a, `${sel} 的 α=${a}——浮层必须是毛玻璃（透出画面），不许改实色`).toBeGreaterThan(0);
      expect(a, `${sel} 的 α=${a}——浮层不许变全透明`).toBeLessThan(1);
      for (const [name, v] of [
        ["r", r],
        ["g", g],
        ["b", b],
      ] as const) {
        expect(v, `${sel} 的 ${name}=${v}——浮层底必须保持深色（压白底画面才可读）`).toBeLessThanOrEqual(30);
      }
    });
  }
});
