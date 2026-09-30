/**
 * 丙-①（2026-09-30）：入站申请浮层的纯判断 + **跨端接线**守卫。
 *
 * 范式照搬 `rcClipPushErr.test.ts` / `lanEvents.test.ts`：算式与码表在 Rust 与前端
 * 各存一份字面量，写错哪一边都不报错——用户看到的就是「还剩 1 秒时后端早拒了」
 * 或「那条申请悄无声息地没了」。所以直接读源码逐字比对。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  rcAskCountdownText,
  rcAskGrantText,
  rcAskLeftMs,
  rcAskNoteText,
  rcAskOfferViewOnly,
  RC_ASK_TTL_MS,
} from "./rcAskPop";

const read = (p: string) => readFileSync(resolve(__dirname, p), "utf-8");

const INBOUND_RS = read("../../src-tauri/src/rc/service/inbound.rs");
const ASK_POP_RS = read("../../src-tauri/src/rc/ask_pop.rs");
const COMMANDS_TS = read("./api/rcCommands.ts");
const CAPS = read("../../src-tauri/capabilities/default.json");

describe("rcAskLeftMs / 倒计时", () => {
  it("刚敲门 = 整 120 秒，显示 2:00", () => {
    expect(rcAskLeftMs(1000, 1000)).toBe(120_000);
    expect(rcAskCountdownText(rcAskLeftMs(1000, 1000))).toBe("2:00");
  });

  it("剩 107 秒 → 1:47（分:秒，秒补零，不写「秒」字）", () => {
    expect(rcAskCountdownText(107_000)).toBe("1:47");
    expect(rcAskCountdownText(60_000)).toBe("1:00");
    expect(rcAskCountdownText(9_000)).toBe("0:09");
  });

  it("超时之后不为负，且不出现 -0:03 这种字样", () => {
    expect(rcAskLeftMs(0, 130_000)).toBe(0);
    expect(rcAskCountdownText(0)).toBe("0:00");
  });
});

describe("分两次授权（设计稿 §丙-① 第② 点）", () => {
  it("申请可控才摆「只同意看屏幕」；申请只看不重复摆", () => {
    expect(rcAskOfferViewOnly("control")).toBe(true);
    expect(rcAskOfferViewOnly("view")).toBe(false);
  });

  it("能力说人话：控制 = 看屏幕 + 控制键鼠", () => {
    expect(rcAskGrantText("control")).toBe("看屏幕 + 控制键鼠");
    expect(rcAskGrantText("view")).toBe("只看屏幕");
  });
});

describe("原因行（设计稿 §丙-① 第③ 点：后端出码、前端出话）", () => {
  it("两条码各有一句人话", () => {
    expect(rcAskNoteText("confirm_timeout")).toContain("自动拒绝");
    expect(rcAskNoteText("pending_full")).toContain("已满");
  });

  it("没见过的码不编造原因", () => {
    expect(rcAskNoteText("whatever")).toBeNull();
    expect(rcAskNoteText(null)).toBeNull();
    expect(rcAskNoteText(undefined)).toBeNull();
  });
});

describe("跨端接线守卫", () => {
  it("前端 TTL 与后端批准等待的 120s 同值（改一边必改另一边）", () => {
    expect(RC_ASK_TTL_MS).toBe(120_000);
    expect(INBOUND_RS).toContain("120_000");
  });

  it("后端只会发这两条码，前端两句都认得", () => {
    const codes = ["confirm_timeout", "pending_full"];
    for (const c of codes) {
      expect(INBOUND_RS, `后端不再写 ${c}，前端那句措辞该一并删`).toContain(`"${c}"`);
      expect(rcAskNoteText(c)).not.toBeNull();
    }
  });

  it("浮层取状态的命令名两边逐字相同", () => {
    expect(ASK_POP_RS).toContain("pub fn rc_ask_state");
    expect(COMMANDS_TS).toContain('invoke("rc_ask_state")');
    expect(COMMANDS_TS).toContain('invoke("rc_ask_hide")');
  });

  it("浮层窗口在权限名单里（漏了 = listen() 全静默失败，卡片永远空白）", () => {
    expect(CAPS).toContain('"rc-ask"');
  });
});
