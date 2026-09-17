import { describe, expect, it } from "vitest";
import {
  actionUnansweredMs,
  frameIdleMs,
  linkStateHint,
  linkStateOf,
  pathKindHint,
  pathKindLabel,
  rttGrade,
  ACTION_UNANSWERED_MS,
  HEARTBEAT_FAIL_MS,
  HEARTBEAT_STALE_MS,
} from "@/lib/rcSessionStats";

const T = 1_000_000; // 任意固定时刻，避免测试受真实时钟影响

describe("linkStateOf（链路活性：只认对端 pong 的新鲜度）", () => {
  it("还没收到过 pong → 连接中", () => {
    expect(linkStateOf(0, T)).toBe("connecting");
  });

  it("pong 新鲜 → 已连接", () => {
    expect(linkStateOf(T - 1, T)).toBe("connected");
    expect(linkStateOf(T - (HEARTBEAT_STALE_MS - 1), T)).toBe("connected");
  });

  it("🔴 pong 陈旧但未超上限 → unstable，而不是 failed", () => {
    // 这是对标 WebRTC 的关键一条：disconnected 是临时态，会自愈，不该报错。
    expect(linkStateOf(T - HEARTBEAT_STALE_MS, T)).toBe("unstable");
    expect(linkStateOf(T - (HEARTBEAT_FAIL_MS - 1), T)).toBe("unstable");
  });

  it("陈旧超过上限 → failed", () => {
    expect(linkStateOf(T - HEARTBEAT_FAIL_MS, T)).toBe("failed");
  });

  it("重连动作进行中优先显示重连中", () => {
    expect(linkStateOf(T - 1, T, true)).toBe("reconnecting");
    // 即便心跳看起来是断的，也要显示「重连中」而不是「已断开」
    expect(linkStateOf(T - HEARTBEAT_FAIL_MS * 2, T, true)).toBe("reconnecting");
  });

  it("unstable 必须带「可能自愈」口径，failed 才给重连指引", () => {
    expect(linkStateHint("unstable")).toContain("恢复");
    expect(linkStateHint("connected")).toBe("");
  });
});

describe("frameIdleMs（画面静：中性观测，不是故障）", () => {
  it("没有帧 / 时间为 0 → 不显示", () => {
    expect(frameIdleMs(T - 99999, T, false)).toBe(0);
    expect(frameIdleMs(0, T, true)).toBe(0);
  });

  it("未超过阈值 → 不显示（避免每次眨眼都冒提示）", () => {
    expect(frameIdleMs(T - 1000, T, true)).toBe(0);
  });

  it("超过阈值 → 返回静止时长", () => {
    expect(frameIdleMs(T - 9000, T, true)).toBe(9000);
  });

  it("🔴 回归钉子：画面静止不改变链路判定", () => {
    // 2026-09-17 的误报根因：被控端画面无变化时刻意不推帧，
    // 旧实现把「2.5s 无新帧」当链路故障 ⇒ 看静止桌面 2.5s 必报错。
    // 下面两行必须同时成立：帧静止为真，链路仍为「已连接」。
    expect(frameIdleMs(T - 60_000, T, true)).toBeGreaterThan(0);
    expect(linkStateOf(T - 1000, T)).toBe("connected");
  });
});

describe("actionUnansweredMs（有后果的操作之后没画面）", () => {
  it("没操作过 → 不提示（用户只是在看静止画面）", () => {
    expect(actionUnansweredMs(T - 60_000, 0, T)).toBe(0);
  });

  it("操作之后收到过新帧 → 对端已响应，不提示", () => {
    expect(actionUnansweredMs(T - 200, T - 1000, T)).toBe(0);
  });

  it("操作后一直没帧且超过阈值 → 提示，并给出等待时长", () => {
    const waited = actionUnansweredMs(T - 10_000, T - 9_000, T);
    expect(waited).toBe(9_000);
  });

  it("未满阈值 → 不提示（编解码+网络本就需要时间）", () => {
    expect(actionUnansweredMs(T - 60_000, T - (ACTION_UNANSWERED_MS - 1), T)).toBe(0);
  });

  it("帧时间戳为 0（首帧都没到）时仍能判出未响应", () => {
    expect(actionUnansweredMs(0, T - 9_000, T)).toBe(9_000);
  });
});

describe("rttGrade（分档阈值）", () => {
  it("0 / 负数 = 尚未测到，不能当成「很快」", () => {
    expect(rttGrade(0)).toBe("unknown");
    expect(rttGrade(-5)).toBe("unknown");
  });

  it("边界值按「上界不含」分档", () => {
    expect(rttGrade(29)).toBe("good");
    expect(rttGrade(30)).toBe("ok");
    expect(rttGrade(59)).toBe("ok");
    expect(rttGrade(60)).toBe("fair");
    expect(rttGrade(199)).toBe("fair");
    expect(rttGrade(200)).toBe("poor");
  });
});

describe("pathKindLabel / pathKindHint（走哪条路）", () => {
  it("三档文案与 Rust PathKind::label 同构", () => {
    expect(pathKindLabel("lan")).toBe("局域网直连");
    expect(pathKindLabel("direct")).toBe("公网直连");
    expect(pathKindLabel("relay")).toBe("绕中继");
  });

  it("未知 / 空串 → 空文案，界面不显示这一格（不猜）", () => {
    expect(pathKindLabel("")).toBe("");
    expect(pathKindLabel(undefined)).toBe("");
    expect(pathKindLabel("custom")).toBe("");
  });

  it("绕中继必须给解释：延迟高≠故障", () => {
    expect(pathKindHint("relay")).toContain("正常");
    expect(pathKindHint("")).toBe("");
  });
});
