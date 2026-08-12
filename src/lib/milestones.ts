/**
 * milestones.ts —— 里程碑时刻判定（v6.8 粘性 B1）。
 *
 * "有思想"的落地：在画像驱动的关键时刻说一句懂你的话。
 * - 安装周年：从 `firstHistoryAt`（最早一条复制）起算，周年后 30 天内触发一次
 * - 历史现存 10 万条：historyCount 跨过 10 万触发一次
 *   （注意是“现存”不是“累计”：清理/删除后这个数会回落，见 achievements.ts 的 bronze）
 * - 画像觉醒：首次完成 AI 精炼后触发一次
 *
 * 已读状态存 localStorage（`pastepanda_milestones_seen`），
 * 触发过的里程碑只在画像页可回看，不反复打扰。
 * 文案里的数字全部来自本地统计，无内容。
 */
import type { StickyStats } from "@/lib/api/sticky";
// 成就数量统一用 achievements.ts 的实现，不在这里再手抄一份
// （achievements.ts 不反向引用本文件，无循环依赖）。
import { ACHIEVEMENTS, unlockedCount } from "@/lib/achievements";

export type MilestoneKind = "anniversary" | "hundred-k" | "awakening";

export interface MilestoneEvent {
  kind: MilestoneKind;
  /** 已读标记的期次（周年=年份，其余固定 v1） */
  stamp: string;
  icon: string;
  tag: string;
  title: string;
  quote: string;
  stats: { value: string; label: string }[];
}

const SEEN_KEY = "pastepanda_milestones_seen";
export const HUNDRED_K = 100_000;

function seenKey(kind: MilestoneKind, stamp: string): string {
  return `${SEEN_KEY}:${kind}:${stamp}`;
}

/** 读该里程碑是否已展示过（stamp 用于区分不同期次，如周年年份） */
export function milestoneSeen(kind: MilestoneKind, stamp: string): boolean {
  try {
    return localStorage.getItem(seenKey(kind, stamp)) === "1";
  } catch {
    return false;
  }
}

/** 标记已展示 */
export function markMilestoneSeen(kind: MilestoneKind, stamp: string): void {
  try {
    localStorage.setItem(seenKey(kind, stamp), "1");
  } catch {
    /* 存储不可用时静默 */
  }
}

/**
 * 检查是否有待展示的里程碑。有则返回事件（调用方负责展示 + 调 markMilestoneSeen）。
 * 优先级：画像觉醒 > 周年 > 10 万次。
 */
export function checkMilestones(s: StickyStats): MilestoneEvent | null {
  const now = new Date();

  // 画像觉醒（首次精炼后只弹一次）
  if (s.profileRefined && !milestoneSeen("awakening", "v1")) {
    return {
      kind: "awakening",
      stamp: "v1",
      icon: "🧠",
      tag: "画像觉醒 · 首次 LLM 精炼完成",
      title: "我开始读懂你了",
      quote:
        "你的核心身份已经浮现：从行为统计里看到的角色与偏好，正在拼出「你是谁」。这份画像会随使用持续进化，你也可以随时修正我。",
      stats: [{ value: "本地聚合", label: "仅统计 · 无内容" }],
    };
  }

  // 安装周年：每个周年日起 30 天内触发一次，每年一个独立期次。
  //
  // 旧实现有两个错：
  // 1. `stamp = first.getFullYear() + 1` 恒为“首年+1”，不随周年递增，
  //    而注释声称“stamp 用于区分不同期次，如周年年份”；
  // 2. 窗口 `daysUsed >= 365 && < 395` 在第 2 周年（≈730 天）直接不满足
  //    → **多周年永远触发不了**，`Math.floor(daysUsed / 365)` 恒为 1，
  //    标题里的 `${years} 年了` 也只能是“1 年”。
  //
  // 现改为按**真实日期**推周年（setFullYear），不再用 365 天硬编码，
  // 因此闰年不会逐年漂移（旧写法 4 年差 1 天）。
  if (s.firstHistoryAt) {
    const first = new Date(s.firstHistoryAt.replace(" ", "T"));
    if (!Number.isNaN(first.getTime())) {
      // 最近一个已到达的周年日：先试今年，未到则回退到去年
      const ann = new Date(first);
      ann.setFullYear(now.getFullYear());
      if (ann.getTime() > now.getTime()) ann.setFullYear(now.getFullYear() - 1);
      const years = ann.getFullYear() - first.getFullYear();
      const daysSinceAnn = Math.floor((now.getTime() - ann.getTime()) / 86_400_000);
      const stamp = String(years); // 期次 = 第几周年，每年不同
      if (years >= 1 && daysSinceAnn < 30 && !milestoneSeen("anniversary", stamp)) {
        return {
          kind: "anniversary",
          stamp,
          icon: "🎂",
          tag: `陪伴 ${years} 周年 · ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
          title: `你用 PastePanda ${years} 年了`,
          quote:
            `你保存了 ${s.historyCount.toLocaleString()} 条历史，最近 12 周活跃 ${s.activeDays} 天。` +
            "谢谢你还在——你的每一步，都让我更懂你。",
          stats: [
            { value: s.historyCount.toLocaleString(), label: "保存的历史" },
            { value: `${s.activeWeekStreak} 周`, label: "连续活跃" },
            { value: `${s.activeDays} 天`, label: "近 12 周活跃" },
          ],
        };
      }
    }
  }

  // 第 10 万次复制（跨过阈值只弹一次）
  if (s.historyCount >= HUNDRED_K && !milestoneSeen("hundred-k", "v1")) {
    return {
      kind: "hundred-k",
      stamp: "v1",
      icon: "🏔",
      tag: "里程碑达成 · 历史现存 100,000 条",
      title: "十万分之一，也是十万分之一",
      quote:
        `你的历史里现存着 ${HUNDRED_K.toLocaleString()} 条记录，攒下了 ${s.customChainCount} 条自定义链、` +
        `${unlockedCount(s)}/${ACHIEVEMENTS.length} 项成就。这些都是你亲手创造的工作方式。`,
      stats: [
        { value: s.historyCount.toLocaleString(), label: "保存的历史" },
        { value: `${s.customChainCount} 条`, label: "自定义链" },
        { value: s.activeDays > 0 ? `${s.activeWeekStreak} 周` : "—", label: "连续活跃" },
      ],
    };
  }

  return null;
}

// （原有的 `unlockedCountText()` 已删：它手抄了 6 项能力累加，而 achievements.ts
//   已导出 `unlockedCount(s)`（8 项）。两份实现必然脱节——新增成就时这里不会
//   跟着更新，里程碑文案与成就墙上的数字就对不上。）
