/**
 * api/semantic.ts — 语义索引（M5-2）。
 * 对应 Rust：commands/semantic.rs + data_store/content_memory.rs。
 *
 * 纪律：出网的只有摘要与搜索词，**原文永不出本机**；开关默认关，
 * 失败一律回退 FTS5 关键词搜索（这里只负责报错，由调用方决定回退）。
 */

import { invoke } from "@tauri-apps/api/core";

/** 语义索引状态（设置页「AI 记忆增强」区展示用） */
export interface SemanticStatus {
  enabled: boolean;
  provider: string;
  providerSupports: boolean;
  model: string;
  defaultModel: string;
  vectorCount: number;
  pending: number;
}

export interface SemanticIndexResult {
  indexed: number;
  pendingLeft: number;
}

/** 一条语义命中（text 是本机历史全文，直接可展示/复制） */
export interface SemanticHit {
  historyId: string;
  score: number;
  summary: string;
  createdAt: string;
  text: string;
}

export function semanticStatus(): Promise<SemanticStatus> {
  return invoke("semantic_status");
}

/** 开关 + 模型覆盖（model 传 null 保留原值） */
export function semanticSetConfig(
  enabled: boolean,
  model: string | null,
): Promise<void> {
  return invoke("semantic_set_config", { enabled, model });
}

export function semanticIndex(limit?: number): Promise<SemanticIndexResult> {
  return invoke("semantic_index", { limit: limit ?? 200 });
}

/** 失败返回 Err（前端回退 FTS5）；成功返回 top-k 命中 */
export function semanticSearch(query: string, limit?: number): Promise<SemanticHit[]> {
  return invoke("semantic_search", { query, limit: limit ?? 10 });
}
