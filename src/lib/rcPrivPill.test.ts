/**
 * 丙-② 隐私角标的纯判断 + 跨端接线守卫。
 *
 * 分两类钉：
 * 1. **算式**：时长口径（负数钳零、过一小时进位）——两台机器时钟不同步是真会发生的，
 *    角标上出现 `-1:23` 比不显示更糟（用户会开始怀疑这条指示本身是不是真的）。
 * 2. **接线**：形态字面量 `"capsule"` 在 Rust 与前端各存一份。写错不报错——后端照样
 *    换档、前端永远渲染卡片，表现退回「被远程时桌面上什么都没有」，正是本条要修的
 *    审计 H1。范式照搬 `rcClipPushErr.test.ts`。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  rcPrivElapsedText,
  rcPrivGrantText,
  rcPrivIsHot,
  rcPrivWhoText,
} from "./rcPrivPill";

const ASK_POP = readFileSync(resolve(__dirname, "../../src-tauri/src/rc/ask_pop.rs"), "utf-8");
const SHELL = readFileSync(resolve(__dirname, "../components/rc/RcAskPop.tsx"), "utf-8");

describe("rcPrivElapsedText（会话时长）", () => {
  const T = 1_700_000_000_000;
  it("mm:ss 口径，秒补零、分不补零", () => {
    expect(rcPrivElapsedText(T, T)).toBe("00:00");
    expect(rcPrivElapsedText(T, T + 9_000)).toBe("00:09");
    expect(rcPrivElapsedText(T, T + 161_000)).toBe("02:41");
  });
  it("过一小时进成 h:mm:ss，不停在 61:23 那种读不懂的数", () => {
    expect(rcPrivElapsedText(T, T + 3_700_000)).toBe("1:01:40");
  });
  it("时钟倒挂（对方机器比本机快）钳到 0，不出现负号", () => {
    expect(rcPrivElapsedText(T, T - 77_000)).toBe("00:00");
  });
});

describe("rcPrivWhoText / 能力档措辞", () => {
  it("设备名为空时兜成「对方」，不留一句没主语的话", () => {
    expect(rcPrivWhoText("DESKTOP-7K2")).toBe("DESKTOP-7K2 正在远程本机");
    expect(rcPrivWhoText("   ")).toBe("对方 正在远程本机");
  });
  it("可控与只看两档各一个短词（264px 的胶囊放不下确认卡那串长句）", () => {
    expect(rcPrivGrantText("control")).toBe("可控");
    expect(rcPrivGrantText("view")).toBe("只看");
    expect(rcPrivIsHot("control")).toBe(true);
    expect(rcPrivIsHot("view")).toBe(false);
  });
});

describe("丙-② 跨端接线", () => {
  it("形态字面量两边逐字相同（写错=角标永远不出现，且不报错）", () => {
    expect(ASK_POP).toContain(`Self::Capsule => "capsule"`);
    expect(SHELL).toContain(`mode === "capsule"`);
  });
  it("角标几何只在 Rust 一处（CSS 里再写一遍 264/28 就是两处真相）", () => {
    expect(ASK_POP).toContain("const CAP_W: f64 = 264.0;");
    expect(ASK_POP).toContain("const CAP_H: f64 = 28.0;");
    const css = readFileSync(resolve(__dirname, "../components/rc/RcPrivPill.module.css"), "utf-8");
    expect(css).not.toMatch(/width:\s*264px/);
    expect(css).not.toMatch(/height:\s*28px/);
  });
  it("免确认设备也给常驻告知（待拍板③）：判据是会话相位，不是走没走同意", () => {
    expect(ASK_POP).toContain("SessionPhase::InboundActive");
  });
});
