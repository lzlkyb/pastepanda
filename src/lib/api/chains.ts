/**
 * api/chains.ts — 自定义动作链的后端调用（X1 B2）。
 * 对应 Rust：data_store/chains.rs + commands/chains.rs。
 */

import { invoke } from "@tauri-apps/api/core";
import type { ChainStep } from "@/lib/chains/types";

/** 一条用户自定义链（与后端 ChainDef 对齐，serde camelCase） */
export interface ChainDef {
  /** 空串 = 新建（后端生成 uuid） */
  id: string;
  name: string;
  description: string;
  /** 步骤：与前端 ChainStep 同构（transformId / risk / label） */
  steps: ChainStep[];
  sortOrder?: number;
  createdAt?: string;
  updatedAt?: string;
}

export const chainList = () => invoke<ChainDef[]>("chain_list");
export const chainSave = (chain: ChainDef) => invoke<string>("chain_save", { chain });
export const chainDelete = (id: string) => invoke<void>("chain_delete", { id });
export const chainReorder = (ids: string[]) => invoke<void>("chain_reorder", { ids });
