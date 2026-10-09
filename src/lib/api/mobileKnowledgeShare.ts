import { addPluginListener, invoke } from "@tauri-apps/api/core";

export interface MobileKnowledgeIncoming {
  id: string;
  title: string;
  text: string;
  /** Validated content-addressed references, suitable for Markdown ![](pp-asset:...). */
  images: string[];
  status: "ready" | "partial" | "error";
  message: string;
  created_at: number;
}
export interface MobileKnowledgeInbox {
  items: MobileKnowledgeIncoming[];
  processing: boolean;
  /** Queue capacity / duplicate notice; receiving never overwrites a note or draft. */
  notice: string;
  /** Native ACTION_SEND intent nonce; ordinary queue changes never request navigation. */
  openRequestId?: string;
}
export const mobileKnowledgeShareList = () =>
  invoke<MobileKnowledgeInbox>("mobile_knowledge_share_list");
/** Call after explicit discard, or after the received contents have been durably saved as a draft. */
export const mobileKnowledgeShareAck = (id: string) =>
  invoke<void>("mobile_knowledge_share_ack", { id });
export const mobileKnowledgeSharePickImages = () =>
  invoke<{ status: "collected"; incomingId: string | null } | { status: "cancelled" }>("mobile_knowledge_share_pick_images");
/** Opened is not proof that another application received or saved the content. */
export const mobileKnowledgeShareSend = (outgoing: { title: string; text: string; imageSources?: string[] }) =>
  invoke<{ status: "opened" }>("mobile_knowledge_share_send", { outgoing });
/** Register once in the app shell; also list on foreground because cold-start events precede JS. */
export const mobileKnowledgeShareListen = (changed: () => void) =>
  addPluginListener("knowledge-share", "incoming", changed);
