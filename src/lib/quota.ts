/**
 * lib/quota.ts —— 免费额度共享业务逻辑（v6.9）。
 *
 * 与后端 data_store/quota.rs 的常量对齐（单一数据源在后端，这里只放
 * 展示层必需的派生函数与常量，避免两端写死漂移）。
 */
import type { QuotaInfo } from "@/lib/api/quota";

/** 初始赠送（token）——与后端 INITIAL_GRANT 对齐 */
export const INITIAL_GRANT = 100_000;
/** 签到基础奖励（第 1 天） */
export const SIGN_BASE = 20_000;
/** 签到每日递增 */
export const SIGN_STEP = 10_000;
/** 签到单日封顶 */
export const SIGN_MAX = 50_000;

/** 连续第 N 天的签到奖励（token） */
export function rewardOf(day: number): number {
  return Math.min(SIGN_BASE + (Math.max(1, day) - 1) * SIGN_STEP, SIGN_MAX);
}

/** token → "12.3万" 展示格式 */
export function fmtWan(n: number): string {
  return `${(n / 10000).toLocaleString()}万`;
}

/** 阶梯格子的衍生结构（供 QuotaDialog / 测试共用） */
export interface LadderCell {
  key: string;
  label: string;
  reward: number;
  done?: boolean;
  today?: boolean;
  future?: boolean;
}

/** 由 QuotaInfo 生成 7 格签到阶梯（已签回顾 + 今天 + 未来补足） */
export function ladderCells(q: QuotaInfo): LadderCell[] {
  const todayDay = q.canSign ? q.signStreak + 1 : Math.max(1, q.signStreak);
  const cells: LadderCell[] = [];
  for (let d = Math.max(1, todayDay - 3); d < todayDay; d++) {
    cells.push({ key: `done-${d}`, label: `第${d}天`, reward: rewardOf(d), done: true });
  }
  cells.push({
    key: "today",
    label: q.canSign ? "今天" : "今天 ✓",
    reward: rewardOf(todayDay),
    today: true,
    done: !q.canSign,
  });
  for (let d = todayDay + 1; cells.length < 7; d++) {
    cells.push({ key: `f-${d}`, label: `第${d}天`, reward: rewardOf(d), future: true });
  }
  return cells;
}

/** 连续 7 天累计可得（与后端 week_total 同值，纯派生防漂移） */
export function weekTotal(): number {
  let sum = 0;
  for (let d = 1; d <= 7; d++) sum += rewardOf(d);
  return sum;
}

/** 内置免费服务商 id（与后端 BUILTIN_AGNES_ID 对齐） */
export const BUILTIN_AGNES_ID = "builtin-agnes";

/** 额度变更事件名（签到/兑换后广播，AiStatusCap 等监听刷新，v6.9 缺陷修复） */
export const QUOTA_CHANGED_EVENT = "pastepanda:quota-changed";

/** 签到/兑换成功后调用：通知其它组件（如余额不足胶囊）刷新额度状态 */
export function notifyQuotaChanged(): void {
  window.dispatchEvent(new CustomEvent(QUOTA_CHANGED_EVENT));
}

/** 监听额度变更；返回取消函数 */
export function onQuotaChanged(fn: () => void): () => void {
  window.addEventListener(QUOTA_CHANGED_EVENT, fn);
  return () => window.removeEventListener(QUOTA_CHANGED_EVENT, fn);
}
