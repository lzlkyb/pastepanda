/**
 * api/sequence.ts — 程序性记忆（V3-B）后端调用。
 * 对应 Rust：data_store/sequence_memory.rs + commands/sequence.rs。
 */

import { invoke } from "@tauri-apps/api/core";

/** 一条高频动作序列建议 */
export interface SequenceSuggestion {
  /** 按出现顺序的动作 id（2~4 步） */
  actions: string[];
  /** 最近 30 天内出现次数 */
  count: number;
  /** 最后一次出现时间（YYYY-MM-DD HH:MM:SS） */
  lastUsed: string;
}

/** 程序性记忆：最近高频动作序列（纯行为统计，无内容） */
export const sequenceSuggest = () => invoke<SequenceSuggestion[]>("sequence_suggest");
