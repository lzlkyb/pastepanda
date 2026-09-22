/**
 * rcHistory — 会话历史的纯查询判据（无 React、无 IO）。
 *
 * 抽出来的原因：同一份 `rc_session_history` 现在有三处消费——
 *  ① 历史页列表（设备 × 方向两个筛选项）
 *  ② 侧栏「按设备筛选」的计数列表
 *  ③ 详情面「最近会话」3 条
 * 三处「这条记录属于哪台设备」必须是同一个判据（`historyPeerKey`），
 * 否则「全部设备 12 条」与「工作电脑 7 条」加起来对不上是迟早的事。
 */
import type { RcHistoryItem } from "@/lib/api/rc";
import { fingerprintOf } from "@/lib/fingerprint";

export type RcHistoryDirFilter = "all" | "outbound" | "inbound";

/** 一条记录属于哪台设备。node_id 是稳定主键；`peer_name` 只是显示名，会变。 */
export function historyPeerKey(h: RcHistoryItem): string {
  return h.peer;
}

/** 设备显示名：优先对端自报名，退到指纹前 8 位（同列表页口径）。 */
export function historyPeerLabel(h: RcHistoryItem): string {
  return h.peer_name?.trim() || fingerprintOf(h.peer);
}

export interface RcHistoryDevice {
  key: string;
  label: string;
  /** 该设备在历史里出现过的条数。 */
  count: number;
  /** 最近一条的起点（ms）。用于排序，不直接显示。 */
  lastMs: number;
}

/**
 * 侧栏「按设备筛选」的数据：历史里出现过的设备 + 各自条数，按最近使用降序。
 *
 * 名字取值不取「第一条」而取「第一条**有名字**的」——同设备早期记录可能没带
 * `peer_name`，若按列表首条取名会退化成指纹，而用户认的是那台设备的名字。
 */
export function summarizeHistoryDevices(list: readonly RcHistoryItem[]): RcHistoryDevice[] {
  const map = new Map<string, { label: string; named: boolean; count: number; lastMs: number }>();
  for (const h of list) {
    if (!h.peer) continue;
    const name = h.peer_name?.trim() ?? "";
    const seen = h.started_ms ?? 0;
    const cur = map.get(h.peer);
    if (!cur) {
      map.set(h.peer, { label: name || fingerprintOf(h.peer), named: Boolean(name), count: 1, lastMs: seen });
      continue;
    }
    cur.count += 1;
    if (seen > cur.lastMs) cur.lastMs = seen;
    if (!cur.named && name) {
      cur.label = name;
      cur.named = true;
    }
  }
  return [...map.entries()]
    .map(([key, v]) => ({ key, label: v.label, count: v.count, lastMs: v.lastMs }))
    .sort((a, b) => b.lastMs - a.lastMs);
}

/**
 * 筛选。设备与方向是**正交**的两个维度，两个条件同时满足才算命中。
 * `peer` 传 null/undefined = 不按设备筛（侧栏选「全部设备」）。
 */
export function filterHistory(
  list: readonly RcHistoryItem[],
  opts: { peer?: string | null; dir?: RcHistoryDirFilter } = {},
): RcHistoryItem[] {
  const peer = opts.peer ?? null;
  const dir = opts.dir ?? "all";
  if (!peer && dir === "all") return [...list];
  return list.filter((h) => (!peer || h.peer === peer) && (dir === "all" || h.dir === dir));
}

/**
 * 详情面「最近会话」：这台设备的最近 N 条。
 *
 * 显式按 `started_ms` 降序排一遍，不依赖后端返回顺序——这里用的是 `slice`，
 * 顺序错了会静默给出「最近 3 条」里的错 3 条，比列表页顺序乱掉更难发现。
 * 入站记录也算（都是本机与它的往来，用户关心的是「和这台设备最近干了什么」）。
 */
export function recentSessionsFor(
  list: readonly RcHistoryItem[],
  peer: string | null | undefined,
  limit = 3,
): RcHistoryItem[] {
  if (!peer || limit <= 0) return [];
  return list
    .filter((h) => h.peer === peer)
    .sort((a, b) => (b.started_ms ?? 0) - (a.started_ms ?? 0))
    .slice(0, limit);
}

/**
 * 这台设备**实测过**的平均延迟（ms），取最近一条带样本的记录。0 = 从没采到过。
 *
 * 设备列表本身不带时延字段（后端只在会话中采 RTT），所以设备行能拿到的「快不快」
 * 只有这个历史实测值——用「最近实测」而不是「预计」，因为后者没有数据源，
 * 编一个数字出来就是假信息。
 */
export function lastMeasuredRtt(
  list: readonly RcHistoryItem[],
  peer: string | null | undefined,
): number {
  if (!peer) return 0;
  const measured = list
    .filter((h) => h.peer === peer && (h.rtt_avg ?? 0) > 0)
    .sort((a, b) => (b.started_ms ?? 0) - (a.started_ms ?? 0));
  return measured[0]?.rtt_avg ?? 0;
}

/** 历史记录的模式文案（详情面与历史页共用，避免两处各写一个三元）。 */
export function historyCapabilityLabel(capability: string): string {
  return capability === "control" ? "可控" : "只看";
}

/**
 * 当前筛的设备已不在列表里（记录被清空、或那台设备的记录被淘汰出 20 条上限）
 * 时退回「全部设备」——否则侧栏会出现「一项都没选中」的死角：列表看着是空，
 * 但用户找不到回到全部的入口。
 */
export function normalizeHistoryPeer(
  peer: string | null,
  devices: readonly RcHistoryDevice[],
): string | null {
  if (!peer) return null;
  return devices.some((d) => d.key === peer) ? peer : null;
}
