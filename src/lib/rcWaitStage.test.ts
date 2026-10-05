/**
 * `rcWaitStage` 分阶段文案单测。
 *
 * 钉的不变量（§17.3）：① 每个会话阶段必须映射到**不同的**主文案——两段共用
 * 一句「等待对方画面…」正是用户分不清卡在哪的原因；② 阈值内不出 hint、
 * 超阈值必出（等太久≠坏了，但必须有人说话）；③ 未知/被控阶段回落原文案。
 */
import { describe, expect, it } from "vitest";
import {
  RC_WAIT_ACTIVE_HINT_MS,
  RC_WAIT_PENDING_HINT_MS,
  rcWaitStage,
} from "./rcWaitStage";

describe("rcWaitStage 分阶段文案", () => {
  it("拨号期（无会话）：正在连接电脑…", () => {
    expect(rcWaitStage(undefined, 0).text).toBe("正在连接电脑…");
    expect(rcWaitStage(null, 500).text).toBe("正在连接电脑…");
    expect(rcWaitStage("idle", 500).text).toBe("正在连接电脑…");
  });

  it("等批准：已通知电脑，等待对方同意…", () => {
    expect(rcWaitStage("outbound_pending", 0).text).toBe("已通知电脑，等待对方同意…");
  });

  it("已批准、编码器在起：电脑正在准备画面…", () => {
    expect(rcWaitStage("outbound_active", 0).text).toBe("电脑正在准备画面…");
  });

  it("被控态/未知：回落等待对方画面…", () => {
    expect(rcWaitStage("inbound_active", 0).text).toBe("等待对方画面…");
    expect(rcWaitStage("inbound_pending", 0).text).toBe("等待对方画面…");
  });

  it("每个阶段主文案互不相同（同一句静默文案就是这次教训）", () => {
    const texts = new Set(
      (["outbound_pending", "outbound_active", "inbound_active", "idle"] as const).map(
        (p) => rcWaitStage(p, 0).text,
      ),
    );
    expect(texts.size).toBe(4);
  });

  it("阈值内不出 hint", () => {
    expect(rcWaitStage("outbound_pending", 0).hint).toBe("");
    expect(rcWaitStage("outbound_pending", RC_WAIT_PENDING_HINT_MS - 1).hint).toBe("");
    expect(rcWaitStage("outbound_active", RC_WAIT_ACTIVE_HINT_MS - 1).hint).toBe("");
  });

  it("超阈值必出 hint（等太久≠坏了，不出声才是问题）", () => {
    expect(rcWaitStage("outbound_pending", RC_WAIT_PENDING_HINT_MS).hint).not.toBe("");
    expect(rcWaitStage("outbound_active", RC_WAIT_ACTIVE_HINT_MS).hint).not.toBe("");
    // 被控态与拨线没有「对方批准」可等，不造 hint
    expect(rcWaitStage("inbound_active", 999_999).hint).toBe("");
    expect(rcWaitStage("idle", 999_999).hint).toBe("");
  });
});
