import { invoke } from "@tauri-apps/api/core";
export interface MobileKnowledgeAssetReceipt { src: string; bytes: number; peer: string; already_local: boolean }
export const mobileKnowledgeAssetFetch = (requestId: string, peerId: string, noteId: string, src: string) =>
  invoke<MobileKnowledgeAssetReceipt>("mobile_knowledge_asset_fetch", { requestId, peerId, noteId, src });
export const mobileKnowledgeAssetCancel = (requestId: string) =>
  invoke<void>("mobile_knowledge_asset_cancel", { requestId });
