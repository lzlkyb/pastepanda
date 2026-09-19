/**
 * rcAdhoc 守卫单测 — 一次性协助「该忘谁、什么时候忘」。
 *
 * 为什么值得单测：这套逻辑的失效方式是**静默残留**——一次性协助用完了，
 * 设备列表里多留一条再也不会用的设备。界面上完全看不出异样，
 * 只有用户过几天打开列表才会发现。而两侧的已知条件不同（协助方粘贴时就知道
 * node_id，被协助方要等对方敲门之后才知道），最容易犯的错是只覆盖了其中一侧。
 *
 * 另外两条边界也只能靠单测钉：
 *  - arm 过期（邀请码 30 分钟失效）后**不能**再认领会话，否则用户几小时后
 *    随手帮别人一次会被误判成一次性，把刚配好的设备删掉；
 *  - 会话还在进行中时**不能**提前结账（用户正被远程着，设备行先消失）。
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { RcSession } from "@/lib/api/rc";
import {
  ADHOC_ARM_TTL_MS,
  armAdhoc,
  clearAdhocPeers,
  loadAdhoc,
  markAdhocPeer,
  stepAdhoc,
  type AdhocState,
} from "@/lib/rcAdhoc";

const T0 = 1_700_000_000_000;

const sess = (peer: string, phase: RcSession["phase"] = "outbound_active"): RcSession => ({
  id: "s1",
  peer,
  peer_name: "对方",
  capability: "view",
  phase,
  started_ms: T0,
  granted: true,
});

const empty: AdhocState = { armedAt: 0, baseline: [], peers: [], live: [] };

beforeEach(() => {
  localStorage.clear();
});

describe("协助方：粘贴时点名", () => {
  it("点名 → 会话结束后被遗忘（且只返一次，不会重复忘）", () => {
    const named = markAdhocPeer("peerA", empty);
    expect(named.peers).toEqual(["peerA"]);

    // 会话真的建立了
    const inCall = stepAdhoc(named, sess("peerA"), T0);
    expect(inCall.forget).toEqual([]); // 进行中不结账

    // 会话结束
    const ended = stepAdhoc(inCall.state, null, T0 + 60_000);
    expect(ended.forget).toEqual(["peerA"]);
    expect(ended.state.peers).toEqual([]);

    // 再喂一次空闲：不该重复忘
    expect(stepAdhoc(ended.state, null, T0 + 61_000).forget).toEqual([]);
  });

  it("从没进过会话（对方不在线 / 申请失败）⇒ 不删设备，用户还能重试", () => {
    const named = markAdhocPeer("peerA", empty);
    const r = stepAdhoc(named, null, T0);
    expect(r.forget).toEqual([]);
    expect(r.state.peers).toEqual(["peerA"]);
  });

  it("pending 阶段就算「进了会话」——对方拒绝也要清掉", () => {
    const named = markAdhocPeer("peerA", empty);
    const pending = stepAdhoc(named, sess("peerA", "outbound_pending"), T0);
    const ended = stepAdhoc(pending.state, null, T0 + 1_000);
    expect(ended.forget).toEqual(["peerA"]);
  });

  it("进行中的另一台设备不受影响（只有点名过的才忘）", () => {
    const named = markAdhocPeer("peerA", empty);
    const other = stepAdhoc(named, sess("peerB"), T0);
    const ended = stepAdhoc(other.state, null, T0 + 1_000);
    expect(ended.forget).toEqual([]);
  });
});

describe("被协助方：出码即武装", () => {
  it("武装后出现的第一个会话被认领，结束后遗忘", () => {
    const armed = armAdhoc(T0, [], empty);
    expect(armed.armedAt).toBe(T0);

    // 谁批准、从哪个窗口批准都无所谓——信号来自 rc_status.session
    const claimed = stepAdhoc(armed, sess("helper", "inbound_active"), T0 + 5_000);
    expect(claimed.state.peers).toEqual(["helper"]);
    // 认领即取消武装：同一段武装期里第二个会话不该再被误判
    expect(claimed.state.armedAt).toBe(0);

    const second = stepAdhoc(claimed.state, sess("someone-else"), T0 + 6_000);
    expect(second.state.peers).toEqual(["helper"]);

    const ended = stepAdhoc(second.state, null, T0 + 60_000);
    expect(ended.forget).toEqual(["helper"]);
  });

  it("🔴 arm 过期（超过邀请码 30 分钟寿命）⇒ 不认领，别误删刚配好的设备", () => {
    const armed = armAdhoc(T0, [], empty);
    const late = stepAdhoc(armed, sess("just-paired"), T0 + ADHOC_ARM_TTL_MS + 1);
    expect(late.state.peers).toEqual([]);
    expect(late.state.armedAt).toBe(0);
    expect(stepAdhoc(late.state, null, T0 + ADHOC_ARM_TTL_MS + 2).forget).toEqual([]);
  });

  it("恰好卡在寿命边界上仍算有效（判据是 <= 而非 <）", () => {
    const armed = armAdhoc(T0, [], empty);
    const edge = stepAdhoc(armed, sess("peerA", "inbound_active"), T0 + ADHOC_ARM_TTL_MS);
    expect(edge.state.peers).toEqual(["peerA"]);
  });

  it("武装了但一直没人来 ⇒ 状态原样保留，不产生任何遗忘", () => {
    const armed = armAdhoc(T0, [], empty);
    const r = stepAdhoc(armed, null, T0 + 1_000);
    expect(r.forget).toEqual([]);
    expect(r.state.armedAt).toBe(T0);
  });
});

describe("落盘", () => {
  it("落盘只存 armedAt / baseline / peers，live 是进程内证据", () => {
    const st = stepAdhoc(markAdhocPeer("peerA", empty), sess("peerA"), T0).state;
    expect(st.live).toEqual(["peerA"]);
    // 直接读盘复核：live 不该被写进去
    const raw = JSON.parse(localStorage.getItem("rc_adhoc") ?? "{}");
    expect(raw).toEqual({ armedAt: 0, baseline: [], peers: ["peerA"] });
    expect(raw.live).toBeUndefined();
  });

  it("清空后不留空对象（避免每次启动都读到一个没用的键）", () => {
    markAdhocPeer("peerA", empty);
    expect(localStorage.getItem("rc_adhoc")).toBeTruthy();
    clearAdhocPeers(loadAdhoc());
    expect(localStorage.getItem("rc_adhoc")).toBeNull();
  });

  it("盘上是垃圾时回落空状态，不让清理逻辑把会话炸掉", () => {
    localStorage.setItem("rc_adhoc", "{oops");
    expect(loadAdhoc()).toEqual(empty);
    localStorage.setItem("rc_adhoc", JSON.stringify({ armedAt: "x", peers: [1, null, "ok"] }));
    expect(loadAdhoc()).toEqual({ armedAt: 0, baseline: [], peers: ["ok"], live: [] });
  });
});

describe("🔴 baseline：别把长期设备误判成一次性", () => {
  it("出码前就配好的设备连过来 → 不认领、不遗忘", () => {
    // 用户开了「让别人帮我」又改主意关掉，30 分钟内自己那台长期笔记本连过来
    const armed = armAdhoc(T0, ["my-laptop"], empty);
    const s = stepAdhoc(armed, sess("my-laptop", "inbound_active"), T0 + 1_000);

    expect(s.state.peers).toEqual([]);
    expect(stepAdhoc(s.state, null, T0 + 2_000).forget).toEqual([]);
    // arm 还留着：真正来帮忙的人还没到
    expect(s.state.armedAt).toBe(T0);
  });

  it("同一次武装里，老设备不认领、新设备照认", () => {
    const armed = armAdhoc(T0, ["my-laptop"], empty);
    const old = stepAdhoc(armed, sess("my-laptop", "inbound_active"), T0 + 1_000);
    const fresh = stepAdhoc(old.state, sess("helper", "inbound_active"), T0 + 2_000);

    expect(fresh.state.peers).toEqual(["helper"]);
    expect(stepAdhoc(fresh.state, null, T0 + 3_000).forget).toEqual(["helper"]);
  });
});
