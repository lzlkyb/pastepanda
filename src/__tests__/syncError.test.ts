/**
 * 同步错误串 → 人话（或判定不该显示）。
 *
 * 🔴 盯的是 2026-09-10 用户报的「知识库同步提示 timed out 看不懂」。
 *
 * 本文件里的输入串**全部按后端真实格式构造**，不是拍的：
 * ・`sync/transport.rs`：`format!("连接对端失败：{}", e)`、`读帧长度失败：{}`、
 *   `format!("写文件失败 {}：{}", path.display(), e)`（全角冒号）；
 * ・`sync/attach.rs` / `engine.rs`：`format!("建附件目录失败: {e}")`（半角冒号 + 空格）；
 * ・`sync/session.rs` 的 `explain`：`format!("{}（{}）", err, close_reason)`。
 */
import { describe, it, expect } from "vitest";
import { explainSyncError } from "@/lib/syncError";

describe("处理不了的一律不显示", () => {
  it("timed out ——就是这条被报了「看不懂」", () => {
    expect(explainSyncError("连接对端失败：timed out")).toBeNull();
  });

  it("connection lost 同理：调用点上一句已经说完了", () => {
    expect(explainSyncError("读帧长度失败：connection lost")).toBeNull();
  });

  it("对方在忙 / 让位根本不是故障", () => {
    // 四个字样与后端 `is_busy_reject` 逐条对应
    expect(explainSyncError("被拒（正在向你发起同步）")).toBeNull();
    expect(explainSyncError("被拒（让位）")).toBeNull();
    expect(explainSyncError("被拒（稍后重试）")).toBeNull();
    expect(explainSyncError("被拒（等待对方确认）")).toBeNull();
  });

  it("空 / undefined / null 都当没有", () => {
    expect(explainSyncError("")).toBeNull();
    expect(explainSyncError(undefined)).toBeNull();
    expect(explainSyncError(null)).toBeNull();
  });
});

describe("能处理的才说话", () => {
  /**
   * 🔴 本文件最重要的一条。
   *
   * `session::explain` 把关闭原因拼在后面，所以真实串里**同时**含有
   * `connection lost`（该静默）与 `not paired`（该报）。
   * 判定顺序一反，这条用户真能处理的错误就被当成「对方没开机」吐掉了。
   */
  it("not paired 被 connection lost 包着时，仍然要认出来", () => {
    const why = explainSyncError("读帧长度失败：connection lost（not paired）");
    expect(why).not.toBeNull();
    expect(why).toContain("重新配对");
  });

  it("真故障只留中文前缀，英文原文交给 title", () => {
    expect(explainSyncError("读帧内容失败：malformed frame")).toBe("读帧内容失败");
  });

  it("半角冒号 + 空格也要认（attach.rs / engine.rs 那几条用的是它）", () => {
    expect(explainSyncError("建附件目录失败: No such file or directory")).toBe(
      "建附件目录失败",
    );
  });

  /**
   * ❗ `transport.rs` 有 `format!("写文件失败 {}：{}", path.display(), e)`，
   *   而 Windows 路径自带 `D:`。切分隔符时光认半角冒号会得到“写文件失败 D”。
   */
  it("Windows 路径里的 D: 不能被当成分隔符", () => {
    const why = explainSyncError("写文件失败 D:\\notes\\a.md：Access is denied");
    expect(why).toBe("写文件失败 D:\\notes\\a.md");
  });

  it("大写的 TIMED OUT 也要认（上游升级可能变大小写）", () => {
    expect(explainSyncError("连接对端失败：Timed Out")).toBeNull();
  });
});
