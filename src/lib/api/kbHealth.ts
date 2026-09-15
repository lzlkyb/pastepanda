/**
 * 库体检 API（N3）——对应 `src-tauri/src/commands/notes.rs` 的 `kb_health`。
 *
 * 字段名与 Rust 结构体一致（snake_case，未过 serde rename）。
 *
 * **失败返 null 而不弹 toast**：体检是一条附加提示，用户正在看笔记，
 * 不该被一条读不出来的统计打断。与 `KbSyncStatusBar` 读同步状态失败时的口径一致。
 */
import { invoke } from "@tauri-apps/api/core";
import { logger } from "@/lib/logger";

/** 一条断链。 */
export interface BrokenLink {
  /** 源笔记 id——点「去那一行」靠它。 */
  from_id: string;
  from_title: string;
  /** 方括号里那个找不到的标题。 */
  to_title: string;
}

/** 一组疑似重复的名字（AM-8 的 `DupGroup`）。 */
export interface DupGroup {
  names: string[];
  /** 归一化后完全相等 = 强候选；否则是距离 1~2 的弱候选。 */
  strong: boolean;
  distance: number;
}

/** 一篇几乎是空的笔记。 */
export interface TinyNote {
  id: string;
  title: string;
  /** 正文字符数。 */
  len: number;
}

/** 一篇由 AI 新建、却还留在未分类里的笔记。 */
export interface UnfiledAiNote {
  id: string;
  title: string;
}

/** 中性统计——展开面板底部那一行，**不是问题**。 */
export interface KbStats {
  note_count: number;
  avg_len: number;
  max_len: number;
  /** 被活笔记用到的标签数，不是全库标签数。 */
  tag_count: number;
  link_count: number;
  /**
   * 未分类的活笔记数。
   *
   * 🔴 **中性统计，不是问题**：真库上未分类能到 96%，那是「没用这个功能」。
   * 该报的只是其中 **AI 自己写的那一半**（见 `unfiled_ai`）。
   */
  unfiled_count: number;
}

/**
 * 一份库体检报告。
 *
 * 每类都是**明细（封顶 5 条）+ 真计数**：界面上那句「还有 N 条」靠计数，
 * 只看数组长度的话截断就变成静默的了。
 */
export interface KbHealth {
  broken_links: BrokenLink[];
  broken_count: number;
  tag_dups: DupGroup[];
  tag_dup_count: number;
  title_dups: DupGroup[];
  title_dup_count: number;
  tiny_notes: TinyNote[];
  tiny_count: number;
  /** AI 新建、还没归类的笔记。**计数是真实总数**，门槛见 `hasUnfiledAi`。 */
  unfiled_ai: UnfiledAiNote[];
  unfiled_ai_count: number;
  stats: KbStats;
}

/**
 * 跑一遍库体检。失败返 `null`（只记日志，不弹 toast）。
 */
export async function kbHealth(): Promise<KbHealth | null> {
  try {
    return await invoke<KbHealth>("kb_health");
  } catch (e) {
    logger.warn("读库体检失败", e);
    return null;
  }
}

/**
 * 有多少**类**问题。顶部条那句「库里有 N 项可以修」用的就是它。
 *
 * 🔴 **数的是类别不是条目**（1 条断链 + 2 篇空笔记 = **2 项**，不是 3）。
 * 条目数会让人以为要点那么多次，而每一类实际上是一次处理。
 *
 * 写成函数而不是在组件里现算：「有没有问题」与「有几项」必须是同一个判据，
 * 两处各算一遍就会出现「条出来了但写着 0 项」这种分叉。
 */
export function healthIssueKinds(h: KbHealth): number {
  return (
    (h.broken_count > 0 ? 1 : 0) +
    (h.tag_dup_count > 0 ? 1 : 0) +
    (h.title_dup_count > 0 ? 1 : 0) +
    (h.tiny_count > 0 ? 1 : 0) +
    (hasUnfiledAi(h) ? 1 : 0)
  );
}

/**
 * 未分类里堆到**几篇**「AI 自己写的」才值得报一项。
 *
 * ❗ 门槛是**语义的一部分**，不是保守：本项报的是「堆积」，
 * 而一篇刚建出来、还没来得及归类的笔记不是堆积——它只是**进行中**。
 * 顶部条跟着 `version` 每次写入都重算，没有门槛的话，
 * AI 正在正常干活的中间态会闪出一条提示。
 *
 * 与 MCP 侧信号（`mcp/pulse.rs` 的 `UNFILED_HINT_MIN` = 5）**故意不同**：
 * 那边喊给 AI 听，门槛高了不喊、喊了就还能救；
 * 这边是给**人**看的，人只能等 AI 去收，所以门槛低一点，
 * 让人更早发现「AI 没在整理」，而不是让 AI 更早被催。
 */
export const UNFILED_AI_MIN = 3;

/**
 * 该不该报「AI 写了没归类」。
 *
 * 写成函数而不是在组件里现算：它同时决定**顶部条出不出**（`healthIssueKinds`）
 * 与**那一行渲不渲染**。两处各写一遍 `>= 3`，迟早会出现
 * 「条出来了、数字也不为 0、但里面那一行不见了」。同 `healthIssueKinds` 的取向。
 */
export function hasUnfiledAi(h: KbHealth): boolean {
  return h.unfiled_ai_count >= UNFILED_AI_MIN;
}
