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
import { rcDisplayName } from "@/lib/rcDevice";

export type RcHistoryDirFilter = "all" | "outbound" | "inbound";

/** 历史条数上限（后端 `rc_session_history` 只保留最近 N 条，超出即丢）。 */
export const RC_HISTORY_MAX = 20;

/** 一条记录属于哪台设备。node_id 是稳定主键；`peer_name` 只是显示名，会变。 */
export function historyPeerKey(h: RcHistoryItem): string {
  return h.peer;
}

/**
 * 设备显示名：后端查询时已按配对表叠加统一显示名（备注优先）到
 * `display_name`；缺失/空（旧版后端或没起备注）回落落库的自报名快照，
 * 再退指纹前 8 位。🔴 走 `rcDisplayName`，别手写 `peer_name ||` 链。
 */
export function historyPeerLabel(h: RcHistoryItem): string {
  return rcDisplayName(h, fingerprintOf(h.peer));
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
    const name = rcDisplayName(h);
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

/** 结果列四态。`cancel` 单列一档而不并进 `warn`：取消是用户主动行为、不是异常，
 * 两处都按中性渲染。 */
export type RcResultTone = "ok" | "warn" | "cancel" | "err";

/**
 * 🔴 会话结果着色的**唯一真源**。历史页（`.phRes`）与详情面「最近会话」
 * （`.recentResult`）两个视图共用本函数 —— 原先是 `RcSessionHistory.tsx` 的
 * 私有函数，往详情面复制一份必然分叉：同一个 `reason` 串在一边绿、在另一边灰。
 *
 * `reason` 是后端给的**自由中文串**（「用户结束会话」/「远程通道关闭」…），不是
 * 枚举 —— 所以只**按关键词给色**、文本原样展示：把「远程通道关闭」硬翻成
 * 「正常结束」才是造假。
 *
 * 2026-09-22 补 `/超时/ → warn`：超时既不是用户意图、也不是正常完成，原先落进
 * 兜底的 `ok` 被染成成功绿（记录页实测能看到）。判定顺序 = 语义优先级：
 * 先「取消」（用户意图，即使原因是超时也以用户动作为准）→ 再「超时」→ 再「拒绝」
 * → 最后「失败|错误|异常」，其余兜底 `ok`。
 */
export function resultTone(reason: string): RcResultTone {
  if (/取消/.test(reason)) return "cancel";
  if (/超时/.test(reason)) return "warn";
  if (/拒绝/.test(reason)) return "warn";
  if (/失败|错误|异常/.test(reason)) return "err";
  return "ok";
}

/**
 * U4：发起的申请**非本人取消**而结束时的当下反馈（与 `resultTone` 同一 reason 口径）。
 *
 * 只认两类用户真正困惑的结局——「被拒」和「超时」；其余不发声：
 * - 「取消」是用户自己点的撤回，撤销条已经给过 toast，再报就是重复；
 * - 网络类失败走的是 `rc.error` 错误槽（RcErrorPanel），那里有完整标题+下一步。
 */
export function requestEndNotice(
  reason: string,
): { tone: "error" | "info"; text: string } | null {
  if (/取消/.test(reason)) return null;
  if (/拒绝/.test(reason)) {
    return { tone: "error", text: "拒绝了这个申请。可以改用「只看」再试，或到记录页看详情。" };
  }
  if (/超时/.test(reason)) {
    return { tone: "info", text: "等待 2 分钟未响应，申请已自动取消。对方可能不在电脑前。" };
  }
  return null;
}

/**
 * U3：会话**进行中结束**（outbound_active 消失）的当下反馈。
 *
 * 2026-09-23 补：旧版只有 `requestEndNotice` 管「申请阶段」的收场；一旦会话
 * 建立过，被对方结束 / 链路异常结束时画面会**静默弹回设备页**，用户分不清
 * 是对方动了手还是自己软件坏了。
 *
 * 🔴 2026-09-23 复审反转默认档：旧版按中文关键词识别故障，QUIC 快于 15 秒
 * 自然报错时 reason 是英文（"connection lost"…）接不住 → 静默。而「静默的
 * 意外结束」正是这条通知要消灭的东西。现在改为**本机主动收场白名单 → 静默；
 * 其余一律报错**——后端将来新增任何 reason 串，默认有反馈而不是默认静默
 * （U3.5 的方向：未知 ≠ 没事）。白名单与各触发点一一对应：
 * 用户点结束 / 关通道 / 忘设备 / 关被控开关 / 主动取消——它们的反馈都在触发处。
 */
const SELF_INITIATED_END_RE =
  /^用户结束会话|^远程通道关闭|^设备已从信任列表移除|^「允许被远程」已关闭|^取消|^已取消/;

export function sessionEndNotice(
  reason: string,
): { tone: "error" | "info"; text: string } | null {
  if (SELF_INITIATED_END_RE.test(reason)) return null;
  if (/对端结束/.test(reason)) {
    return { tone: "info", text: "对方结束了这次会话" };
  }
  // TTL 到期的串是后端固定的「会话超时」；「对端失联（心跳超时）」含 超时
  // 但语义是失联，必须走默认 error 档——所以这里匹配整串而不是关键词。
  if (/^会话超时/.test(reason)) {
    return { tone: "info", text: "达到会话时长上限，已自动结束" };
  }
  return { tone: "error", text: "连接已中断，可在设备页重新发起，或检查双方网络" };
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
