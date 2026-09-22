/**
 * rcWorkbench 守卫单测 — 工作台主区分支判据。
 *
 * 存在的理由：上一版的判据是内联的 `phase === "outbound_active"`，把 inbound
 * **整个漏掉**——用户正被别人控着，主区却显示「在左侧选择一台设备发起远程」。
 * 这种「漏一个分支」的错读代码看不出来（两个分支各自都写得对），
 * 但把判据变成可枚举的纯函数后，一条表驱动测试就能钉死全部分支。
 */
import { describe, it, expect } from "vitest";
import { isSessionActive, workbenchMainMode } from "@/lib/rcWorkbench";
import type { RcSession, RcStatus } from "@/lib/api/rc";

const session = (phase: RcSession["phase"]): RcSession => ({
  id: "s1",
  peer: "peerA",
  peer_name: "甲机",
  capability: "view",
  phase,
  started_ms: 0,
  granted: true,
});

/** 只填本判据用得到的字段，其余按「无」处理（status 其余部分与分支无关）。 */
const status = (phase: RcSession["phase"] | null): RcStatus =>
  ({
    enabled: true,
    session: phase ? session(phase) : null,
  }) as RcStatus;

describe("workbenchMainMode", () => {
  it("五个 phase 全部映射到位（尤其 inbound 不能再落到 idle）", () => {
    const table: [RcSession["phase"], string][] = [
      ["idle", "idle"],
      ["outbound_pending", "pending"],
      ["outbound_active", "outbound"],
      ["inbound_active", "inbound"],
      ["inbound_pending", "inbound"],
    ];
    for (const [phase, want] of table) {
      expect(workbenchMainMode(status(phase)), `phase=${phase}`).toBe(want);
    }
  });

  it("status 为 null / session 为 null 都是 idle（首帧 status 还没到）", () => {
    expect(workbenchMainMode(null)).toBe("idle");
    expect(workbenchMainMode(status(null))).toBe("idle");
  });
});

describe("isSessionActive", () => {
  it("任何非 idle 的会话都算「进行中」——侧栏据此锁住一切发起", () => {
    expect(isSessionActive(status("inbound_active"))).toBe(true);
    expect(isSessionActive(status("outbound_pending"))).toBe(true);
    expect(isSessionActive(status("outbound_active"))).toBe(true);
    expect(isSessionActive(status("idle"))).toBe(false);
    expect(isSessionActive(null)).toBe(false);
  });
});

