import { describe, expect, it } from "vitest";
import type { RcHistoryItem } from "@/lib/api/rc";
import {
  filterHistory,
  historyCapabilityLabel,
  historyPeerKey,
  historyPeerLabel,
  lastMeasuredRtt,
  normalizeHistoryPeer,
  recentSessionsFor,
  summarizeHistoryDevices,
} from "@/lib/rcHistory";

const A = "aaaa1111bbbb2222cccc";
const B = "dddd3333eeee4444ffff";

function item(over: Partial<RcHistoryItem> = {}): RcHistoryItem {
  return {
    peer: A,
    peer_name: "工作电脑",
    capability: "control",
    dir: "outbound",
    started_ms: 1000,
    ended_ms: 2000,
    duration_ms: 1000,
    reason: "正常结束",
    ...over,
  };
}

describe("summarizeHistoryDevices", () => {
  it("按设备归组，计数与总数守恒（侧栏「全部 N 条」要等于各设备之和）", () => {
    const list = [
      item({ started_ms: 5 }),
      item({ started_ms: 4 }),
      item({ started_ms: 3 }),
      item({ peer: B, peer_name: "家里的电脑", started_ms: 2 }),
      item({ peer: B, peer_name: "家里的电脑", started_ms: 1 }),
    ];

    const devices = summarizeHistoryDevices(list);
    expect(devices).toHaveLength(2);
    expect(devices.reduce((acc, d) => acc + d.count, 0)).toBe(list.length);
    expect(devices.find((d) => d.key === A)?.count).toBe(3);
    expect(devices.find((d) => d.key === B)?.count).toBe(2);
  });

  it("按最近使用降序——B 更近时排在 A 前面", () => {
    const devices = summarizeHistoryDevices([
      item({ started_ms: 10 }),
      item({ peer: B, peer_name: "家里的电脑", started_ms: 99 }),
    ]);

    expect(devices.map((d) => d.key)).toEqual([B, A]);
  });

  it("名字取「有名字的那条」而不是列表首条——首条缺名时不该退化成指纹", () => {
    const devices = summarizeHistoryDevices([
      item({ started_ms: 99, peer_name: "" }),
      item({ started_ms: 1, peer_name: "工作电脑" }),
    ]);

    expect(devices).toHaveLength(1);
    expect(devices[0].label).toBe("工作电脑");
  });

  it("全都没名字时才退到指纹", () => {
    const devices = summarizeHistoryDevices([item({ peer_name: "" })]);

    expect(devices[0].label).toBe("aaaa-1111-bbbb-2222");
  });

  it("peer 为空串的脏记录被跳过，不进筛选列表", () => {
    const devices = summarizeHistoryDevices([item({ peer: "" }), item({})]);

    expect(devices).toHaveLength(1);
    expect(devices[0].count).toBe(1);
  });

  it("空历史给空列表，不造一条「全部设备」出来", () => {
    expect(summarizeHistoryDevices([])).toEqual([]);
  });
});

describe("filterHistory", () => {
  const list = [
    item({ started_ms: 5, dir: "outbound" }),
    item({ started_ms: 4, dir: "inbound" }),
    item({ peer: B, started_ms: 3, dir: "outbound" }),
  ];

  it("不传条件时返回全部（且是新数组，不把调用方的列表改掉）", () => {
    const out = filterHistory(list);
    expect(out).toHaveLength(3);
    expect(out).not.toBe(list);
    expect(list).toHaveLength(3);
  });

  it("只按设备筛", () => {
    expect(filterHistory(list, { peer: B }).map((h) => h.started_ms)).toEqual([3]);
  });

  it("只按方向筛", () => {
    expect(filterHistory(list, { dir: "inbound" }).map((h) => h.started_ms)).toEqual([4]);
  });

  it("设备与方向是正交的两维，同时生效", () => {
    expect(filterHistory(list, { peer: A, dir: "inbound" }).map((h) => h.started_ms)).toEqual([4]);
    expect(filterHistory(list, { peer: B, dir: "inbound" })).toEqual([]);
  });

  it("peer 传 null 等于不按设备筛", () => {
    expect(filterHistory(list, { peer: null, dir: "outbound" })).toHaveLength(2);
  });
});

describe("recentSessionsFor", () => {
  it("跨设备过滤 + 按开始时间倒序 + 截断到 3 条", () => {
    const list = [
      item({ started_ms: 1000, reason: "最旧" }),
      item({ started_ms: 5000, reason: "第三" }),
      item({ peer: B, started_ms: 9000, reason: "别的设备" }),
      item({ started_ms: 3000, reason: "更旧" }),
      item({ started_ms: 7000, reason: "第二" }),
      item({ started_ms: 9000, reason: "第一" }),
    ];

    expect(recentSessionsFor(list, A, 3).map((h) => h.reason)).toEqual(["第一", "第二", "第三"]);
  });

  it("入站记录也算——用户关心的是「和这台设备最近干了什么」", () => {
    const out = recentSessionsFor([item({ dir: "inbound", reason: "对方连我" })], A, 3);

    expect(out.map((h) => h.reason)).toEqual(["对方连我"]);
  });

  it("没有选中设备 / limit 非正时给空数组，不退化成「最近 3 条全局记录」", () => {
    const list = [item()];
    expect(recentSessionsFor(list, null, 3)).toEqual([]);
    expect(recentSessionsFor(list, undefined, 3)).toEqual([]);
    expect(recentSessionsFor(list, A, 0)).toEqual([]);
  });

  it("不修改传入的数组顺序", () => {
    const list = [item({ started_ms: 1 }), item({ started_ms: 9 })];
    void recentSessionsFor(list, A, 3);
    expect(list.map((h) => h.started_ms)).toEqual([1, 9]);
  });
});

describe("normalizeHistoryPeer", () => {
  const devices = summarizeHistoryDevices([item({}), item({ peer: B, peer_name: "家里的电脑" })]);

  it("筛的设备还在列表里就原样返回", () => {
    expect(normalizeHistoryPeer(A, devices)).toBe(A);
  });

  it("筛的设备已从列表消失（记录被清空 / 被 20 条上限淘汰）时退回全部", () => {
    expect(normalizeHistoryPeer("gone-node-id", devices)).toBeNull();
  });

  it("本来就是「全部」时保持 null", () => {
    expect(normalizeHistoryPeer(null, devices)).toBeNull();
  });
});

describe("lastMeasuredRtt", () => {
  it("取最近一条有样本的记录，跳过没采到样本的（更早的记录没这个字段）", () => {
    expect(
      lastMeasuredRtt(
        [
          item({ started_ms: 9000 }),
          item({ started_ms: 5000, rtt_avg: 12 }),
          item({ started_ms: 1000, rtt_avg: 40 }),
        ],
        A,
      ),
    ).toBe(12);
  });

  it("样本为 0 / 全没样本 / 没选中设备时给 0，前端据此不显示这一格", () => {
    expect(lastMeasuredRtt([item({ rtt_avg: 0 })], A)).toBe(0);
    expect(lastMeasuredRtt([item({ started_ms: 9 })], A)).toBe(0);
    expect(lastMeasuredRtt([item({ rtt_avg: 12 })], null)).toBe(0);
  });

  it("不拿别的设备的样本充当这台", () => {
    expect(lastMeasuredRtt([item({ peer: B, rtt_avg: 33 })], A)).toBe(0);
  });
});

describe("historyPeerLabel / historyCapabilityLabel", () => {
  it("有名字用名字，空白名字退指纹", () => {
    expect(historyPeerLabel(item())).toBe("工作电脑");
    expect(historyPeerLabel(item({ peer_name: "  " }))).toBe("aaaa-1111-bbbb-2222");
  });

  it("模式文案只认 control，其余按只看（未知值不冒充可控）", () => {
    expect(historyCapabilityLabel("control")).toBe("可控");
    expect(historyCapabilityLabel("view")).toBe("只看");
    expect(historyCapabilityLabel("")).toBe("只看");
  });

  it("peer 键就是 node_id，与显示名无关", () => {
    expect(historyPeerKey(item({ peer_name: "改过的名字" }))).toBe(A);
  });
});
