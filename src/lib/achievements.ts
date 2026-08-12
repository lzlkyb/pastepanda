/**
 * achievements.ts —— 成就定义与判定（v6.8 粘性 A3）。
 *
 * **真实成就导向**（调研警示：不奖励"打开 App N 次"这类虚荣指标）：
 * 每个成就都对应一个深度功能的使用或一个真实的长期积累，
 * 引导用户从"只是复制粘贴"走向"用上 AI / 动作链 / 画像"。
 *
 * 判定全部基于 `StickyStats`（本地聚合），零出网、零内容。
 */
import type { StickyStats } from "@/lib/api/sticky";

export interface AchievementDef {
  id: string;
  name: string;
  desc: string;
  icon: string;
  /** 判定函数：给粘性数据返回是否解锁 */
  unlocked: (s: StickyStats) => boolean;
  /** 未解锁时的进度提示文案 */
  hint: (s: StickyStats) => string;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  {
    id: "first-ai",
    name: "第一次飞跃",
    desc: "首次使用 AI 动作",
    icon: "✨",
    unlocked: (s) => s.aiUsed,
    hint: () => "复制内容后在变换枢纽里试试 AI 动作",
  },
  {
    id: "structured",
    name: "结构化人生",
    desc: "首次生成 JSON / SQL",
    icon: "🧩",
    unlocked: (s) => s.toolUsed,
    hint: () => "用「生成正则 / 生成 SQL」把描述变成工具",
  },
  {
    id: "triage",
    name: "我会排错",
    desc: "用过排错流水线",
    icon: "🛠",
    unlocked: (s) => s.triageUsed,
    hint: () => "连续复制报错代码时，试试「一起排错」",
  },
  {
    id: "chain-creator",
    name: "方法论之父",
    desc: "保存第一条自定义链",
    icon: "🔗",
    unlocked: (s) => s.customChainCount >= 1,
    hint: () => "在动作链编辑器里把你的流程存成链",
  },
  {
    id: "portable",
    name: "可移植的灵魂",
    desc: "导出画像 / SKILL",
    icon: "📦",
    unlocked: (s) => s.profileExported,
    hint: () => "在导出区把画像存成 Markdown / SKILL",
  },
  {
    id: "bronze",
    name: "百炼成钢",
    // 文案说“现存”而不是“累计”：historyCount = `COUNT(*) FROM history`，
    // 而 history 有保留天数自动清理、深度清理、手动删除——这个数**会往下掉**。
    // 原文案写“累计复制 10 万次”，用户清一次历史就会发现“累计”居然可以减少。
    // 要做真正的累计需要一个单调递增的持久计数器（history 用 uuid 主键，没有自增
    // 序列可借），属新增基础设施；按项目自己的原则，先让文案不说谎。
    desc: "历史现存达 10 万条",
    icon: "🏔",
    unlocked: (s) => s.historyCount >= 100_000,
    hint: (s) => `已保存 ${s.historyCount.toLocaleString()} 条历史`,
  },
  {
    id: "veteran",
    name: "老兵不死",
    desc: "连续活跃 12 周",
    icon: "🕰",
    unlocked: (s) => s.activeWeekStreak >= 12,
    hint: (s) => `当前连续 ${s.activeWeekStreak} 周`,
  },
  {
    id: "awakening",
    name: "画像觉醒",
    desc: "画像完成 AI 精炼",
    icon: "🧠",
    unlocked: (s) => s.profileRefined,
    hint: () => "在画像页用 AI 把统计润色成你的描述",
  },
];

/** 按定义顺序计算解锁集合 */
export function unlockedIds(s: StickyStats): Set<string> {
  return new Set(ACHIEVEMENTS.filter((a) => a.unlocked(s)).map((a) => a.id));
}

/** 解锁数量（进度条用） */
export function unlockedCount(s: StickyStats): number {
  return unlockedIds(s).size;
}

/** 最近的一个未解锁成就（"下一步"引导；全解锁返回 null） */
export function nextAchievement(s: StickyStats): AchievementDef | null {
  for (const a of ACHIEVEMENTS) {
    if (!a.unlocked(s)) return a;
  }
  return null;
}
