/**
 * RC 远程错误分档。
 *
 * 🔴 2026-09 用户实测：拨号握手读 Accept 时拿到
 * 「读帧长度失败：connection lost」，界面落到「远程申请未成功」——
 * 分不清是对方关了、中继瞬断，还是本端静默丢包。
 */
import { describe, it, expect } from "vitest";
import { explainRcError } from "@/lib/rcDeny";

describe("connection lost 要认出来", () => {
  it("握手读帧时的 connection lost", () => {
    const info = explainRcError("读帧长度失败：connection lost");
    expect(info.kind).toBe("offline");
    expect(info.title).toContain("断开");
    expect(info.hint.length).toBeGreaterThan(10);
    expect(info.reason).toContain("connection lost");
  });

  it("读帧内容失败也算同一条", () => {
    const info = explainRcError("读帧内容失败：connection lost");
    expect(info.kind).toBe("offline");
    expect(info.title).toContain("断开");
  });

  it("对端明确 close 原因时仍归 connection_lost，但 reason 保留原文", () => {
    const info = explainRcError("读帧长度失败：connection lost（closed by peer）");
    expect(info.kind).toBe("offline");
    expect(info.reason).toContain("closed by peer");
  });
});

describe("带 code 的仍然优先走 code", () => {
  it("[disabled] 不会被 reason 里出现的 connection 抢走", () => {
    const info = explainRcError("[disabled] 对方未开启");
    expect(info.kind).toBe("disabled");
  });

  it("[connect_failed] 与 connection_lost 分开", () => {
    const info = explainRcError("[connect_failed] 连接对端失败：timed out");
    expect(info.kind).toBe("offline");
    expect(info.title).toBe("连接对端失败");
  });
});

/**
 * 🔴 2026-09-17：后端原先把「窗口过期」塌缩成 `not_paired`，
 * 而用户实际撞到的**几乎总是窗口过期**——文案指不到「回去重新生成一个」，
 * 于是他只能反复重试同一个失效的码。这组用例是那条修复的守卫。
 */
describe("窗口过期要与「从未配对」分开", () => {
  it("[invite_door_closed] 要指到真实存在的按钮", () => {
    const info = explainRcError("[invite_door_closed] 对方的邀请窗口已过期");
    expect(info.title).toContain("窗口已过期");
    // 「生成并复制」是 `RcPairCreatePane` 上真实存在的按钮名；
    // 写成不存在的「重新生成」等于让用户去找一个没有的按钮。
    expect(info.hint).toContain("生成并复制");
    expect(info.kind).toBe("not_paired");
  });

  it("本地那条不带 code 的「邀请码已过期」也走同一档", () => {
    // `invite::decode` 的报错不带 `[code]` 前缀，但意思与要做的动作完全一致。
    const info = explainRcError(
      "这份邀请码已过期（生成于 31 分钟前，有效期 30 分钟）。请在对方那台重新生成一份。"
    );
    expect(info.title).toContain("窗口已过期");
    expect(info.reason).toContain("31 分钟前");
  });

  it("[pair_denied] 说明是对方拒过，别让人干等", () => {
    const info = explainRcError("[pair_denied] 对方拒绝过本次配对请求");
    expect(info.title).toContain("拒绝");
    expect(info.hint).toContain("重新生成");
  });

  it("旧的 [not_paired] 不该被新档抢走", () => {
    const info = explainRcError("[not_paired] 尚未远程配对");
    expect(info.title).toBe("尚未远程配对");
  });
});
