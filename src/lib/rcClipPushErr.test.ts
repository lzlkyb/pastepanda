/**
 * D11 接线守卫（2026-09-22 审计）：推送剪贴板失败的**回帧名**与**事件名**在
 * Rust 三处、前端一处各存一份字面量。任何一处写错都不会报任何错——后端照发、
 * 前端永远收不到，表现就退回「静默失败 + 界面谎报已推送」，正是这一轮要修的
 * 那个 bug。所以直接读源码逐字比对，范式照搬 `lanEvents.test.ts`。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(__dirname, p), "utf-8");

const INBOUND = read("../../src-tauri/src/rc/inbound.rs");
const OUTBOUND = read("../../src-tauri/src/rc/outbound.rs");
const LIB_RS = read("../../src-tauri/src/lib.rs");
const HOOK = read("../hooks/useRcSessionNotices.ts");

/** 被控端 → 发起端：这条剪贴板没写进去，附原因。 */
const FRAME = "clip_push_err";
/** 后端 → 前端：把原因交给 toast。 */
const EVENT = "rc-clip-push-error";

describe("D11 推送剪贴板失败回帧的接线", () => {
  it("被控端三条失败路径都要回帧（只看会话 / 超限 / 写剪贴板失败）", () => {
    const hits = INBOUND.split(`"${FRAME}"`).length - 1;
    expect(
      hits,
      "inbound.rs 里 clip_push_err 少于 3 处 = 有失败路径又变成了只写日志",
    ).toBeGreaterThanOrEqual(3);
  });

  it("发起端接收循环要认这条回帧", () => {
    expect(OUTBOUND).toContain(`"${FRAME}"`);
  });

  it("后端抛的事件名与前端监听的名字逐字相同", () => {
    expect(LIB_RS).toContain(`"${EVENT}"`);
    expect(HOOK).toContain(`"${EVENT}"`);
  });

  it("事件名非空（空串两边也会「相等」，但监听不到任何东西）", () => {
    expect(EVENT.length).toBeGreaterThan(0);
  });
});
