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
