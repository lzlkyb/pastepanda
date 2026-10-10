import { invoke } from "@tauri-apps/api/core";
import type { Note } from "./notes";

/** Independent durable edit slot. The immutable base prevents overwriting remote changes. */
export interface MobileKnowledgeEditDraft {
  id: string;
  revision: number;
  note_id: string;
  base_version: string;
  base_note: Note;
  title: string;
  content: string;
  folder_id: string | null;
  tag_ids: string[];
  updated_at: string;
}
export type MobileKnowledgeEditResult =
  | { status: "saved"; note: Note; relinked: number }
  | { status: "conflict"; latest: Note }
  | { status: "deleted" };

export const mobileKnowledgeEditGet = () =>
  invoke<MobileKnowledgeEditDraft | null>("mobile_knowledge_edit_get");
export const mobileKnowledgeEditBegin = (noteId: string) =>
  invoke<MobileKnowledgeEditDraft>("mobile_knowledge_edit_begin", { noteId });
export const mobileKnowledgeEditPut = (draft: MobileKnowledgeEditDraft) =>
  invoke<MobileKnowledgeEditDraft>("mobile_knowledge_edit_put", { draft });
/** Conflict/deletion retains the slot. Flush the latest revision before saving. */
export const mobileKnowledgeEditCommit = (id: string, revision: number) =>
  invoke<MobileKnowledgeEditResult>("mobile_knowledge_edit_commit", { id, revision });
/** Explicit independent copy; retries never create another note or revive a deleted copy. */
export const mobileKnowledgeEditCopy = (id: string, revision: number) =>
  invoke<MobileKnowledgeEditResult>("mobile_knowledge_edit_copy", { id, revision });
export const mobileKnowledgeEditClear = (id: string, revision: number) =>
  invoke<void>("mobile_knowledge_edit_clear", { id, revision });
