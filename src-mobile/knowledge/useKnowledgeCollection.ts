import { useEffect, useRef, useState } from "react";
import type { useKnowledgeDraft } from "./useKnowledgeDraft";
import type { useKnowledgeEdit } from "./useKnowledgeEdit";
import type { useKnowledgeInbox } from "./useKnowledgeInbox";
import type { MobileKnowledgeIncoming } from "@/lib/api/mobileKnowledgeShare";
import { knowledgeCollectedContent, knowledgeErrorText } from "@/lib/utils";

export function useKnowledgeCollection({ active, editing, maintaining, draft, edit, inbox, setEditing, setMaintaining, setSelected, onCaptured }: {
  active: boolean; editing: boolean; maintaining: boolean;
  draft: ReturnType<typeof useKnowledgeDraft>; edit: ReturnType<typeof useKnowledgeEdit>; inbox?: ReturnType<typeof useKnowledgeInbox>;
  setEditing: (value: boolean) => void; setMaintaining: (value: boolean) => void; setSelected: (id: string | null) => void; onCaptured: (id: string) => void;
}) {
  const [incomingId, setIncomingId] = useState<string | null>(null);
  const [collectionTarget, setCollectionTarget] = useState<"capture" | "edit" | null>(null);
  const [targetDraftId, setTargetDraftId] = useState<string | null>(null);
  const [appliedIncomingId, setAppliedIncomingId] = useState<string | null>(null);
  const [pickFinished, setPickFinished] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [collectionError, setCollectionError] = useState("");
  const [collectionSuccess, setCollectionSuccess] = useState("");
  const seenIncoming = useRef(new Set<string>());
  const collectionBusy = useRef(false);
  const appliedCollections = useRef(new Map<string, { target: "capture" | "edit"; draftId: string; durable: boolean; noteId?: string; savePending?: boolean }>());
  const incoming = inbox?.items.find(item => item.id === incomingId) || null;
  useEffect(() => {
    const first = inbox?.items[inbox.items.length - 1];
    if (!active || !first || editing || maintaining || !draft.ready || seenIncoming.current.has(first.id)) return;
    seenIncoming.current.add(first.id); setIncomingId(first.id); setCollectionTarget(null);
  }, [active, inbox?.items, editing, maintaining, draft.ready]);
  const pickImages = async (target: "capture" | "edit" | null) => {
    if (!inbox || inbox.picking) return;
    setCollectionError(""); setCollectionSuccess(""); setCollectionTarget(target);
    const draftId = target === "capture" ? draft.draft?.id : target === "edit" ? edit.draft?.id : null;
    pickContext.current = { target, draftId: draftId || null }; setPickFinished(false);
    if (await inbox.pickImages()) setPickFinished(true);
    else { pickContext.current = null; setCollectionTarget(null); }
  };
  const pickContext = useRef<{ target: "capture" | "edit" | null; draftId: string | null } | null>(null);
  useEffect(() => {
    const context = pickContext.current;
    if (!context || !pickFinished) return;
    const item = inbox?.items.find(candidate => candidate.id === inbox.pickedId);
    if (item) {
      const currentId = context.target === "capture" ? draft.draft?.id : context.target === "edit" ? edit.draft?.id : null;
      const sameDraft = !context.target || currentId === context.draftId;
      seenIncoming.current.add(item.id);
      if (sameDraft && context.target && item.status === "ready") {
        pickContext.current = null;
        void collect(item, false, context);
        return;
      }
      setIncomingId(item.id);
      setCollectionTarget(sameDraft ? context.target : null); setTargetDraftId(sameDraft ? context.draftId : null);
      setAppliedIncomingId(appliedCollections.current.has(item.id) ? item.id : null);
      if (!sameDraft) setCollectionError("原草稿已经变化，图片已单独保留，没有加入另一份草稿。");
      pickContext.current = null;
    }
  }, [inbox?.items, inbox?.pickedId, pickFinished, draft.draft?.id, edit.draft?.id]);
  const collect = async (item: MobileKnowledgeIncoming, saveNow = false, picked?: { target: "capture" | "edit" | null; draftId: string | null }) => {
    const target = picked?.target ?? collectionTarget;
    const expectedDraftId = picked?.draftId ?? targetDraftId;
    if (!inbox || collectionBusy.current) return;
    collectionBusy.current = true; setCollecting(true); setCollectionError("");
    try {
      const applied = appliedCollections.current.get(item.id);
      if (applied) {
        const current = applied.target === "edit" ? edit : draft;
        if (current.draft?.id === applied.draftId) {
          await current.flush(); applied.durable = true;
          if (applied.target === "edit") setMaintaining(true);
          else { setEditing(true); setMaintaining(false); setSelected(null); }
        } else if (!applied.durable) throw new Error("收集草稿已变化，请回到原草稿核对内容后清理这次收集");
      } else if (target === "edit") {
        if (!edit.draft || edit.locked || edit.saving) throw new Error("草稿正在保存");
        if (edit.draft.id !== expectedDraftId) throw new Error("原修改草稿已变化，图片仍保留在待收集内容中");
        edit.update("content", knowledgeCollectedContent(item.text, item.images, edit.draft.content));
        appliedCollections.current.set(item.id, { target: "edit", draftId: edit.draft.id, durable: false }); setAppliedIncomingId(item.id); await edit.flush();
        appliedCollections.current.get(item.id)!.durable = true;
      } else if (target === "capture") {
        if (!draft.draft || draft.locked || draft.saving) throw new Error("草稿正在保存");
        if (draft.draft.id !== expectedDraftId) throw new Error("原记录草稿已变化，图片仍保留在待收集内容中");
        draft.update("content", knowledgeCollectedContent(item.text, item.images, draft.draft.content));
        appliedCollections.current.set(item.id, { target: "capture", draftId: draft.draft.id, durable: false }); setAppliedIncomingId(item.id); await draft.flush();
        appliedCollections.current.get(item.id)!.durable = true;
      } else {
        if (!await draft.begin({ id: item.id, title: item.title, content: knowledgeCollectedContent(item.text, item.images) })) {
          setCollectionError("已有草稿仍保留，请先继续或放弃原草稿。分享内容没有覆盖它。"); return;
        }
        appliedCollections.current.set(item.id, { target: "capture", draftId: item.id, durable: false }); setAppliedIncomingId(item.id);
        await draft.flush(); appliedCollections.current.get(item.id)!.durable = true; setEditing(true); setMaintaining(false); setSelected(null);
      }
      const receipt = appliedCollections.current.get(item.id);
      if (saveNow && !receipt?.noteId) {
        // A failed reply may outlive its editor; never commit another draft on its retry.
        if (!receipt || receipt.target !== "capture") {
          throw new Error("原收集草稿已变化，当前草稿没有被保存。请先核对原笔记，再清理这次收集。");
        }
        receipt.savePending = true;
        const saved = await draft.save(receipt.draftId);
        if (!saved) throw new Error("笔记尚未确认保存。内容已保留为草稿，请重试核对。");
        if (receipt) { receipt.noteId = saved.id; receipt.savePending = false; }
        setEditing(false); setMaintaining(false);
        onCaptured(saved.id);
      }
      if (!await inbox.acknowledge(item.id)) { setIncomingId(item.id); setCollectionTarget(target); setTargetDraftId(expectedDraftId); setCollectionError(receipt?.noteId ? "笔记已保存到手机，待收集状态未能清理。重试不会重复保存。" : "内容已保留为手机草稿，收集状态未能清理。可以继续写，稍后重试清理。"); }
      else { if (target) setCollectionSuccess("图片已加入当前草稿，已保存到手机"); appliedCollections.current.delete(item.id); setAppliedIncomingId(null); setIncomingId(null); setCollectionTarget(null); }
    } catch (cause) { setCollectionError(knowledgeErrorText(cause)); setIncomingId(item.id); setCollectionTarget(target); setTargetDraftId(expectedDraftId); }
    finally { collectionBusy.current = false; setCollecting(false); }
  };
  const chooseCollection = (id: string) => { setIncomingId(id); setCollectionTarget(null); setTargetDraftId(null); setCollectionError(""); setAppliedIncomingId(appliedCollections.current.has(id) ? id : null); };
  const showCollection = () => { const latest = inbox?.items[inbox.items.length - 1]; if (latest) chooseCollection(latest.id); };
  const noteSaved = (id: string) => {
    for (const receipt of appliedCollections.current.values()) {
      if (receipt.target === "capture" && receipt.draftId === id) {
        receipt.noteId = id; receipt.durable = true; receipt.savePending = false;
      }
    }
  };
  const receipt = incoming && appliedCollections.current.get(incoming.id);
  return { incoming, incomingId, collectionTarget, appliedIncomingId, appliedSaved: !!receipt?.noteId, savePending: !!receipt?.savePending, collecting, collectionError, collectionSuccess, dismissSuccess: () => setCollectionSuccess(""), pickImages, collect, chooseCollection, showCollection, noteSaved,
    close: () => { setIncomingId(null); setCollectionTarget(null); },
    discard: async (id: string) => { if (inbox && await inbox.acknowledge(id)) { appliedCollections.current.delete(id); setAppliedIncomingId(null); setIncomingId(null); setCollectionTarget(null); } },
  };
}
