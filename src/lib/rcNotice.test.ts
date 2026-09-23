import { describe, expect, it } from "vitest";
import { explainRcError, rcErrorRetryable } from "@/lib/rcDeny";
import { requestEndNotice } from "@/lib/rcHistory";

/** U3：设备页错误槽的「重试连接」只给再点可能成功的错误（与 RcStage 的 B2 同源）。 */
describe("rcErrorRetryable（U3：重试按钮只给假按钮点不着的地方免了）", () => {
  it("busy / timeout / offline 三类可重试", () => {
    expect(rcErrorRetryable("[busy] 对方已有进行中的远程会话")).toBe(true);
    expect(rcErrorRetryable("[confirm_timeout] 对方未在 2 分钟内确认")).toBe(true);
    expect(rcErrorRetryable("[connect_failed] 连接对端失败")).toBe(true);
  });

  it("disabled / device_denied / not_paired / capability 给重试就是假按钮", () => {
    expect(rcErrorRetryable("[disabled] 对方未开启允许被远程协助")).toBe(false);
    expect(rcErrorRetryable("[device_denied] 对方已禁止这台设备远程")).toBe(false);
    expect(rcErrorRetryable("[not_paired] 尚未远程配对")).toBe(false);
    expect(rcErrorRetryable("[capability_too_high] 申请的能力超过对方上限")).toBe(false);
  });

  it("认不出的错误（other）不给重试", () => {
    expect(rcErrorRetryable("完全不认识的报错")).toBe(false);
  });

  it("与 explainRcError 的 kind 口径一致（防两处数组漂移）", () => {
    for (const raw of [
      "[busy] x",
      "[confirm_timeout] x",
      "[connect_failed] x",
      "[channel_down] x",
      "[disabled] x",
    ]) {
      expect(rcErrorRetryable(raw)).toBe(
        ["busy", "timeout", "offline"].includes(explainRcError(raw).kind),
      );
    }
  });
});

/** U4：申请被拒/超时的当下反馈分档（文案语气与 resultTone 同一 reason 口径）。 */
describe("requestEndNotice（U4：结束的当下不再静默跳回）", () => {
  it("被拒 → error 档，给下一步", () => {
    const n = requestEndNotice("对方拒绝了这个申请");
    expect(n?.tone).toBe("error");
    expect(n?.text).toContain("拒绝");
  });

  it("超时 → info 档，说明自动取消", () => {
    const n = requestEndNotice("等待 2 分钟超时");
    expect(n?.tone).toBe("info");
    expect(n?.text).toContain("自动取消");
  });

  it("用户自己取消的不报（撤销条已有 toast）", () => {
    expect(requestEndNotice("用户取消申请")).toBeNull();
  });

  it("网络类失败不报（rc.error 错误槽已有完整呈现）", () => {
    expect(requestEndNotice("连接对端失败")).toBeNull();
    expect(requestEndNotice("读帧长度失败：connection lost")).toBeNull();
  });
});
