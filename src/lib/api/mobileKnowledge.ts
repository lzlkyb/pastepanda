import { invoke } from "@tauri-apps/api/core";
import type { Note } from "./notes";
import type { NoteFolder } from "./noteFolders";
import type { Tag } from "@/stores/appStore";

export interface MobileNoteMeta {
  common: boolean;
  last_access_at: string | null;
  reading_position: number;
}
export interface MobileNoteSummary extends MobileNoteMeta {
  id: string;
  title: string;
  excerpt: string;
  updated_at: string;
  folder_id: string | null;
  folder_name: string | null;
  tags: Tag[];
}
export interface MobileKnowledgeListOptions {
  query?: string;
  folder_filter?: string;
  tag_ids?: string[];
  view?: "recent" | "common" | "all";
  offset?: number;
  /** Internal wiki-link resolution; matches a complete title, without guessing. */
  exact_title?: string;
}
export interface MobileKnowledgePage {
  items: MobileNoteSummary[];
  has_more: boolean;
}
/** One durable local draft. id is a UUID retained across save retries. */
export interface MobileKnowledgeDraft {
  id: string;
  revision: number;
  title: string;
  content: string;
  /** Optional for pre-upgrade drafts; persisted with the same revision as the text. */
  folder_id?: string | null;
  tag_ids?: string[];
  updated_at?: string;
}

// Errors remain rejected: the mobile caller owns visible feedback and draft retention.
export const mobileKnowledgeList = (options: MobileKnowledgeListOptions = {}) =>
  invoke<MobileKnowledgePage>("mobile_knowledge_list", { options });
export const mobileKnowledgeGet = (id: string) => invoke<Note | null>("note_get", { id });
export const mobileKnowledgeFolders = () => invoke<NoteFolder[]>("folder_list");
export const mobileKnowledgeTags = () => invoke<Tag[]>("get_tags");
export const mobileKnowledgeResolve = (title: string) =>
  mobileKnowledgeList({ exact_title: title, view: "all" });
/** Read only a content-addressed image inside this app's images directory. */
export const mobileKnowledgeImage = (src: string) =>
  invoke<string>("mobile_knowledge_image", { src });
export const mobileKnowledgeMeta = (id: string) =>
  invoke<MobileNoteMeta>("mobile_knowledge_meta", { id });
export const mobileKnowledgeSetCommon = (id: string, common: boolean) =>
  invoke<MobileNoteMeta>("mobile_knowledge_set_common", { id, common });
/** Position is a normalized ratio in [0, 1], independent of device orientation. */
export const mobileKnowledgeVisit = (id: string, readingPosition: number) =>
  invoke<MobileNoteMeta>("mobile_knowledge_visit", { id, readingPosition });
export const mobileKnowledgeDraftGet = () =>
  invoke<MobileKnowledgeDraft | null>("mobile_knowledge_draft_get");
/** Increment revision before writing. Older writes cannot overwrite newer text. */
export const mobileKnowledgeDraftPut = (draft: MobileKnowledgeDraft) =>
  invoke<MobileKnowledgeDraft>("mobile_knowledge_draft_put", { draft });
export const mobileKnowledgeDraftClear = (id: string, revision: number) =>
  invoke<void>("mobile_knowledge_draft_clear", { id, revision });
/** Flush draft writes first. Commit creates an independent note and clears it atomically. */
export const mobileKnowledgeDraftCommit = (id: string, revision: number) =>
  invoke<Note>("mobile_knowledge_draft_commit", { id, revision });
