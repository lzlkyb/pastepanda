import { describe, expect, it } from "vitest";
import { normalizeHistoryPeer, sessionEndNotice } from "@/lib/rcHistory";

/**
 * sessionEndNotice 的判据是**关键词分档**，而 reason 串由后端自由文本下发。
 * 这组测试把当前后端全部 force_end/end_session reason 逐条钉住：
 * 后端新增/改写文案时这里会红，逼两边对表（规则 11.1）。
 */
describe("sessionEndNotice（会话结束原因 → 反馈分档）", () => {
  it("对端结束（后端将在 End 帧理由上加「对端结束：」前缀）→ info", () => {
    expect(sessionEndNotice("对端结束：用户结束会话")).toEqual({
      tone: "info",
      text: "对方结束了这次会话",
    });
  });

  it("异常断流各来源 → error，且给出重发起指引", () => {
    // 与 src-tauri 现文案对表（grep force_end_if_session 的全部调用点）
    for (const r of ["画面流中断", "画面推送失败", "H.264 推送失败", "控制通道断开"]) {
      expect(sessionEndNotice(r)?.tone).toBe("error");
    }
  });

  it("🔴 失联类必须落 error，不得被「（心跳超时）」抢进时长上限档", () => {
    // 「对端失联（心跳超时）」串里同时有 失联 和 超时 两个关键词——
    // TTL 档现在只认整串前缀「会话超时」，这条走默认 error。
    expect(sessionEndNotice("对端失联（心跳超时）")?.tone).toBe("error");
  });

  it("🔴 默认档是 error：英文传输错误 / 未来新增的未知 reason 不得静默（U3.5）", () => {
    expect(sessionEndNotice("读帧长度失败：connection lost（timed out）")?.tone).toBe("error");
    expect(sessionEndNotice("后端某天新增的任意话术")?.tone).toBe("error");
  });

  it("TTL 到期 → info，文案说清是时长上限", () => {
    expect(sessionEndNotice("会话超时")).toEqual({
      tone: "info",
      text: "达到会话时长上限，已自动结束",
    });
  });

  it("本机自己的显式操作 → 静默（反馈在触发处，不当惊弓之鸟）", () => {
    // 白名单与后端触发点一一对应（commands/rc.rs、service/lifecycle.rs）
    expect(sessionEndNotice("用户结束会话")).toBeNull();
    expect(sessionEndNotice("远程通道关闭")).toBeNull();
    expect(sessionEndNotice("设备已从信任列表移除")).toBeNull();
    expect(sessionEndNotice("「允许被远程」已关闭")).toBeNull();
    expect(sessionEndNotice("已取消")).toBeNull();
  });
});

describe("normalizeHistoryPeer（筛选失效退回全部）", () => {
  const dev = { key: "a", label: "甲", count: 1, lastMs: 0 };
  const other = { key: "other", label: "乙", count: 1, lastMs: 0 };
  it("未选或所选设备已不在列表 → null（全部）", () => {
    expect(normalizeHistoryPeer(null, [])).toBeNull();
    expect(normalizeHistoryPeer("gone", [other])).toBeNull();
  });
  it("仍在列表则保留", () => {
    expect(normalizeHistoryPeer("a", [dev])).toBe("a");
  });
});
