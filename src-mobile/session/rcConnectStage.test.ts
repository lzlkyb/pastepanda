import { describe, expect, it } from "vitest";
import { RC_RELAY_WAIT_EXTRA, rcConnectStage } from "./rcConnectStage";

describe("rcConnectStage：发起链三段映射（① 甲+乙稿）", () => {
  it("拨号/等批准/起画面 → 1/2/3，无会话也算拨号", () => {
    expect(rcConnectStage(undefined, "", false)?.stage).toBe(1);
    expect(rcConnectStage(null, "", false)?.stage).toBe(1);
    expect(rcConnectStage("idle", "", false)?.stage).toBe(1);
    expect(rcConnectStage("outbound_pending", "", false)?.stage).toBe(2);
    expect(rcConnectStage("outbound_active", "", false)?.stage).toBe(3);
  });

  it("被控态不走发起链 → null 回退现役卡", () => {
    expect(rcConnectStage("inbound_pending", "", false)).toBeNull();
    expect(rcConnectStage("inbound_active", "relay", true)).toBeNull();
  });

  it("路径胶囊只信机器值；未知宁缺不说", () => {
    expect(rcConnectStage("outbound_active", "", false)?.pill).toBe("");
    expect(rcConnectStage("outbound_active", "direct", false)).toMatchObject({ pill: "直连", pillWarn: false });
    expect(rcConnectStage("outbound_active", "lan", false)).toMatchObject({ pill: "局域网", pillWarn: false });
    expect(rcConnectStage("outbound_active", "relay", false)).toMatchObject({ pill: "绕中继", pillWarn: true });
  });

  it("中继超时话术只在「起画面+绕中继+等太久」三条件齐时出", () => {
    expect(rcConnectStage("outbound_pending", "relay", true)?.relayExtra).toBe("");
    expect(rcConnectStage("outbound_active", "relay", false)?.relayExtra).toBe("");
    expect(rcConnectStage("outbound_active", "direct", true)?.relayExtra).toBe("");
    expect(rcConnectStage("outbound_active", "relay", true)?.relayExtra).toBe(RC_RELAY_WAIT_EXTRA);
  });
});
