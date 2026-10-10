import { invoke } from "@tauri-apps/api/core";
import type { Note } from "./notes";

export interface MobileArticleImage { url: string; local: string | null; bytes: number }
export interface MobileArticle {
  id: string; revision: number; url: string; title: string; author: string;
  html: string; body: string; remarks: string; folder_id: string | null; tag_ids: string[];
  images: MobileArticleImage[]; error: string; note_id: string | null;
  source_ids: string[];
  duplicate_note_id: string | null; saved_link_only: boolean;
  baseline_title: string; baseline_content: string;
}
export type MobileArticleFields = Pick<MobileArticle, "revision" | "title" | "body" | "remarks" | "folder_id" | "tag_ids">;
export const mobileArticleBegin = (url: string, sourceId?: string) => invoke<MobileArticle>("mobile_article_begin", { url, sourceId: sourceId || null });
export const mobileArticleGet = (id: string) => invoke<MobileArticle>("mobile_article_get", { id });
export const mobileArticleAckSources = (id: string, sources: string[]) => invoke<MobileArticle>("mobile_article_ack_sources", { id, sources });
export const mobileArticlePending = () => invoke<MobileArticle[]>("mobile_article_pending");
export const mobileArticleForNote = (id: string) => invoke<MobileArticle | null>("mobile_article_for_note", { id });
export const mobileArticlePut = (id: string, fields: MobileArticleFields) => invoke<MobileArticle>("mobile_article_put", { id, fields: {
  revision: fields.revision, title: fields.title, body: fields.body, remarks: fields.remarks,
  folder_id: fields.folder_id, tag_ids: fields.tag_ids,
} });
export const mobileArticleFetch = (id: string) => invoke<MobileArticle>("mobile_article_fetch", { id });
export const mobileArticleSave = (id: string, revision: number, linkOnly: boolean) => invoke<Note>("mobile_article_save", { id, revision, linkOnly });
export const mobileArticleImageFetch = (id: string, index: number) => invoke<MobileArticle>("mobile_article_image_fetch", { id, index });
