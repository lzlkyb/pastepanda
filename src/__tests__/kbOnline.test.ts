/**
 * 知识库设备在线判据的行为钉子。
 *
 * 为何需要它：这个判据曾经只看 `live`（组播听得见），而后端的 `transport`
 * 正是用「presence 有没有地址」算出来的——于是 `wan` 与「在 live 里」互斥，
 * WAN 对端每 30 秒同步成功一次却一律显示「离线」（2026-09-07 用户实测）。
 */
import { describe, it, expect } from "vitest";
import type { KbDevice } from "@/hooks/useKbSync";
import type { KbLastSync } from "@/hooks/useKbSync";
import {
  isKbDeviceOnline, countKbOnline, kbOnlineLabel, kbDeviceProblem, hasKbRelayPeer,
  ONLINE_STALE_MS,
} from "@/lib/kbOnline";

const NOW = 1_788_745_000_000;

function dev(over: Partial<KbDevice> = {}): KbDevice {
  return {
    node_id: "a".repeat(64),
    name: "台式机",
    paired_at: "2026-09-07 09:05:43.328",
    transport: "",
    conn_state: "offline",
    last_seen: 0,
    relay_addr: "",
    sync_cursor_ms: 0,
    ...over,
  };
}

describe("知识库设备在线判据", () => {
  it("组播听得见 → 在线、标「局域网」", () => {
    const d = dev();
    expect(isKbDeviceOnline(d, [d.node_id], NOW)).toBe(true);
    expect(kbOnlineLabel(d, [d.node_id], NOW)).toBe("局域网");
  });

  // 🔴 这条就是那个 bug。旧实现（只看 live）在这里会返回 false。
  it("组播听不见但后端刚同步成功（WAN）→ 仍然在线，标「外网」", () => {
    const d = dev({ conn_state: "online", transport: "wan", last_seen: NOW - 8_400 });
    expect(isKbDeviceOnline(d, [], NOW)).toBe(true);
    expect(kbOnlineLabel(d, [], NOW)).toBe("外网");
  });

  it("从没连上过（last_seen=0）→ 离线", () => {
    const d = dev({ conn_state: "offline", last_seen: 0 });
    expect(isKbDeviceOnline(d, [], NOW)).toBe(false);
    expect(kbOnlineLabel(d, [], NOW)).toBe("离线");
  });

  // 进程被杀时 conn_state 会定在 online，不能拿它当永久在线。
  it("conn_state 说 online 但 last_seen 已陈旧 → 离线", () => {
    const d = dev({ conn_state: "online", transport: "wan", last_seen: NOW - ONLINE_STALE_MS - 1 });
    expect(isKbDeviceOnline(d, [], NOW)).toBe(false);
    expect(kbOnlineLabel(d, [], NOW)).toBe("离线");
  });

  // 刚好卡在边界上的一拍不该闪。
  it("last_seen 恰在阈值上 → 还算在线", () => {
    const d = dev({ conn_state: "online", transport: "wan", last_seen: NOW - ONLINE_STALE_MS });
    expect(isKbDeviceOnline(d, [], NOW)).toBe(true);
  });

  // 🔴 这条与改之前相反，是刻意的。改之前 transport 是猜的，所以宁可信组播；
  //    现在它是「上一次同步成功时数据实际走的那条路」，而组播只证明同子网可见。
  //    组播听得见、数据却在绕中继（AP 隔离挡了打洞但没挡组播）正是这个标签要
  //    暴露的事，让组播优先就会把它掩成「局域网」。
  it("组播听得见但实测走的是中继 → 标「绕中继」，不能掩成「局域网」", () => {
    const d = dev({ conn_state: "online", transport: "relay", last_seen: NOW - 1_000 });
    expect(kbOnlineLabel(d, [d.node_id], NOW)).toBe("绕中继");
  });

  it("打洞成功的公网直连单独一档，不与中继混成「外网」", () => {
    const d = dev({ conn_state: "online", transport: "direct", last_seen: NOW - 1_000 });
    expect(kbOnlineLabel(d, [], NOW)).toBe("公网直连");
  });

  // 🔴 旧值必须继续认。改判据之前落库的行就是 lan/wan，不认就会掉进
  //    「在线」那条兜底，界面上凭空多出一个没人写过的标签。
  it("旧值 wan 仍然标「外网」", () => {
    const d = dev({ conn_state: "online", transport: "wan", last_seen: NOW - 1_000 });
    expect(kbOnlineLabel(d, [], NOW)).toBe("外网");
  });

  it("计数：组播一台 + WAN 一台 + 离线一台 = 2", () => {
    const lan = dev({ node_id: "b".repeat(64) });
    const wan = dev({ node_id: "c".repeat(64), conn_state: "online", transport: "wan", last_seen: NOW - 5_000 });
    const off = dev({ node_id: "d".repeat(64) });
    expect(countKbOnline([lan, wan, off], [lan.node_id], NOW)).toBe(2);
  });

  // 🔴 判据从「在线但听不到组播」换成实测的 transport === "relay"。
  //    旧判据把打洞成功的公网直连也算成中继，异地两台直连得很好时也会报警。
  it("中继告警只看实测的 relay，不看组播", () => {
    const relay = dev({ conn_state: "online", transport: "relay", last_seen: NOW - 5_000 });
    expect(hasKbRelayPeer([relay], [], NOW)).toBe(true);
    // 🔴 组播听得见也照样算：那正是「同一局域网却在绕中继」这个要暴露的情形。
    expect(hasKbRelayPeer([relay], [relay.node_id], NOW)).toBe(true);

    const direct = dev({ conn_state: "online", transport: "direct", last_seen: NOW - 5_000 });
    expect(hasKbRelayPeer([direct], [], NOW)).toBe(false);
    // ❗ 旧值 wan 分不出直连与中继，宁可漏报也不误报。
    const wan = dev({ conn_state: "online", transport: "wan", last_seen: NOW - 5_000 });
    expect(hasKbRelayPeer([wan], [], NOW)).toBe(false);
    expect(hasKbRelayPeer([dev()], [], NOW)).toBe(false);
  });
});

function lastOf(over: Partial<KbLastSync> = {}): KbLastSync {
  return {
    peer: "a".repeat(64),
    at_ms: NOW - 1_000,
    created: 0, updated: 0, deleted: 0, skipped_older: 0, conflicts: 0,
    missing_files: 0, import_failed: 0, clock_too_far_ahead_ms: null,
    assets_landed: 0, assets_skipped: 0, diverged_buckets: 0,
    fails: 0, error: null, next_in_secs: 30,
    last_ok_ms: NOW - 1_000, dormant: false,
    ...over,
  };
}

describe("离线原因的文案", () => {
  // 🔴 后端算好的可操作原因，设置面板以前从来不渲染——只显一个字「离线」。
  it("优先用后端给的 error", () => {
    const d = dev({ last_seen: NOW - 600_000 });
    const l = lastOf({ fails: 3, error: "对方还没把这台设备加回去" });
    expect(kbDeviceProblem(d, [l], [], NOW)).toBe("对方还没把这台设备加回去");
  });

  // 就是用户库里那台 be0d5954：配过对、last_seen=0、从未同步。
  it("从未连上过且后端也没记录：给出可操作的提示而不是沉默", () => {
    const d = dev({ last_seen: 0 });
    const msg = kbDeviceProblem(d, [], [], NOW);
    expect(msg).toBeTruthy();
    expect(msg).toContain("忘记");
  });

  // 在线但上一拨失败过是常态（碰撞 / 丢包），那时报错只会吓人。
  it("在线时一律不说", () => {
    const d = dev({ conn_state: "online", transport: "wan", last_seen: NOW - 2_000 });
    const l = lastOf({ fails: 1, error: "上一拨碰上了" });
    expect(kbDeviceProblem(d, [l], [], NOW)).toBeNull();
  });
});
