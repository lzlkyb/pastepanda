/**
 * challenges.ts —— 本周挑战推荐（v6.8 粘性 B2）。
 *
 * 基于**行为缺口**（画像同构的本地统计）推荐"下一个值得试的能力"：
 * 没用过 AI → 推荐 AI；没建过链 → 推荐建链……完成零惩罚，纯引导。
 *
 * 完成判定 = 对应能力已经用过（sticky 布尔），与成就墙联动；
 * 不撒谎说"本周必须"，只是把缺口变成可点的下一步。
 */
import type { StickyStats } from "@/lib/api/sticky";

export interface ChallengeDef {
  id: string;
  name: string;
  desc: string;
  icon: string;
  /** 已完成（对应能力已具备） */
  done: (s: StickyStats) => boolean;
  /** 未完成时的引导文案（点「去试试」跳转的目标描述） */
  hint: string;
}

/** 挑战池：按"从浅到深"排列（AI 基础 → 工具 → 链 → 画像） */
const POOL: ChallengeDef[] = [
  {
    id: "try-ai",
    name: "试试 AI 动作",
    desc: "你还没用过 AI——从翻译或总结开始",
    icon: "🌐",
    done: (s) => s.aiUsed,
    hint: "复制内容 → 变换枢纽 → AI 分组",
  },
  {
    id: "try-tool",
    name: "生成一次工具",
    desc: "把一句描述变成可用的正则 / SQL",
    icon: "🧩",
    done: (s) => s.toolUsed,
    hint: "粘贴自然语言描述 → 生成正则 / 生成 SQL",
  },
  {
    id: "try-triage",
    name: "跑一次排错流水线",
    desc: "连续复制报错代码，让 AI 帮你修",
    icon: "🛠",
    done: (s) => s.triageUsed,
    hint: "整桶报错代码时会建议「一起排错」",
  },
  {
    id: "make-chain",
    name: "建一条专属链",
    desc: "把常用流程固化成一条动作链",
    icon: "🔗",
    done: (s) => s.customChainCount > 0,
    hint: "动作链运行器 → 新建链",
  },
  {
    id: "export-profile",
    name: "导出你的画像",
    desc: "让别的 AI 工具一眼认识你",
    icon: "📦",
    done: (s) => s.profileExported,
    hint: "画像导出区 → Markdown / SKILL",
  },
  {
    id: "refine-profile",
    name: "让 AI 读懂你",
    desc: "把画像统计润色成一段人话描述",
    icon: "🧠",
    done: (s) => s.profileRefined,
    hint: "画像页 → AI 画像描述",
  },
];

/**
 * 推荐挑战：未完成的排前面（最多 3 条），已完成的后置。
 * 打开周报时调用，返回的数组可直接渲染。
 */
export function suggestChallenges(s: StickyStats): ChallengeDef[] {
  const undone = POOL.filter((c) => !c.done(s));
  const done = POOL.filter((c) => c.done(s));
  return [...undone, ...done].slice(0, 3);
}
