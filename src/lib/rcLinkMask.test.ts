/**
 * rcLinkMask 守卫单测（甲-③，2026-09-29）。
 *
 * 钉的是「什么时候该遮、遮了说哪一句」这张表。三个退化方向都对应真实的说谎：
 * - 没画面还遮 ⇒ 遮罩与 placeholder 同屏两条错误文案互相打脸；
 * - unstable 也遮 ⇒ 把「网络抖动、会自愈」说成「已经断了」，用户会去点结束会话；
 * - failed 且无在途尝试却说「正在尝试恢复」⇒ 那条连接确实已经死了，得重新征得同意。
 *
 * 乙-⑤（2026-09-29）补了第三组：episode 结束时那句「已恢复」的三个前提。
 */
import { describe, expect, it } from "vitest";
import { rcLinkMaskPhase, rcReconnectPrimaryOf, rcReconnectRecoveredOf } from "./rcLinkMask";

const at = (state: string, hasFrame = true, busy = false) =>
  rcLinkMaskPhase({ hasFrame, state: state as never, busy });

describe("rcLinkMaskPhase", () => {
  it("没有画面 → 不遮（placeholder 已经在说话）", () => {
    expect(at("failed", false)).toBeNull();
    expect(at("reconnecting", false)).toBeNull();
  });

  it("connected / unstable / connecting → 不遮", () => {
    expect(at("connected")).toBeNull();
    expect(at("unstable")).toBeNull();
    expect(at("connecting")).toBeNull();
  });

  it("reconnecting → recovering（不管在途与否，状态机自己说了在重连）", () => {
    expect(at("reconnecting")).toBe("recovering");
    expect(at("reconnecting", true, true)).toBe("recovering");
  });

  it("failed + 在途重连 → recovering；failed 且没在试 → consent", () => {
    expect(at("failed", true, true)).toBe("recovering");
    expect(at("failed")).toBe("consent");
  });

  it("unstable 永不遮：它会自愈（linkStateHint 自己写着「正在等待恢复」）", () => {
    expect(at("unstable", true, true)).toBeNull();
  });
});

describe("rcReconnectPrimaryOf（甲-④ 一级重连的出现条件）", () => {
  it("正常态与首次建链都不出现——一级不许常驻占宽", () => {
    expect(rcReconnectPrimaryOf("connected")).toBe(false);
    expect(rcReconnectPrimaryOf("connecting")).toBe(false);
  });

  it("三档中断态都要出现：遮罩可能因为「没有画面」而不亮，一级按钮是另一条腿", () => {
    expect(rcReconnectPrimaryOf("unstable")).toBe(true);
    expect(rcReconnectPrimaryOf("reconnecting")).toBe(true);
    expect(rcReconnectPrimaryOf("failed")).toBe(true);
  });
});

describe("rcReconnectRecoveredOf（乙-⑤ 只讲结果：「已恢复」的三个前提）", () => {
  const ep = (gave_up = false) => ({ peer: "peer-a", gave_up });

  it("在途 → 清空，且这台对端此刻真有会话 ⇒ 才算恢复", () => {
    expect(rcReconnectRecoveredOf({ prev: ep(), now: null, livePeer: "peer-a" })).toBe(true);
  });

  it("手动结束会话也清空 episode ⇒ 没有会话就不许说「已恢复」", () => {
    expect(rcReconnectRecoveredOf({ prev: ep(), now: null, livePeer: null })).toBe(false);
    expect(rcReconnectRecoveredOf({ prev: ep(), now: null, livePeer: "peer-b" })).toBe(false);
  });

  it("gave_up 那支不弹「已恢复」（它是失败），episode 还在跑也不弹", () => {
    expect(rcReconnectRecoveredOf({ prev: ep(true), now: null, livePeer: "peer-a" })).toBe(false);
    expect(rcReconnectRecoveredOf({ prev: ep(), now: ep(), livePeer: "peer-a" })).toBe(false);
    expect(rcReconnectRecoveredOf({ prev: null, now: null, livePeer: "peer-a" })).toBe(false);
  });
});
