import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { mobileKnowledgeVisit } from "@/lib/api/mobileKnowledge";
import { MobileNotice, type MobileFeedback } from "../ui/MobileNotice";
import { MobileSheet } from "../ui/MobileSheet";
import { KnowledgeList } from "./KnowledgeList";
import { KnowledgeFilters } from "./KnowledgeFilters";
import { KnowledgeEditor } from "./KnowledgeEditor";
import { KnowledgeReader } from "./KnowledgeReader";
import { KnowledgeSync } from "./KnowledgeSync";
import { useKnowledgeList } from "./useKnowledgeList";
import { useKnowledgeDraft } from "./useKnowledgeDraft";
import { useKnowledgeEdit } from "./useKnowledgeEdit";
import type { useKnowledgeInbox } from "./useKnowledgeInbox";
import type { MobileKnowledgeIncoming } from "@/lib/api/mobileKnowledgeShare";
import { knowledgeCollectedContent, knowledgeErrorText } from "@/lib/utils";
import { KnowledgeEditPanel } from "./KnowledgeEditPanel";
import { KnowledgeCollectionSheet } from "./KnowledgeCollectionSheet";
import ui from "../ui/MobileUi.module.css";
import styles from "./KnowledgeView.module.css";

export function KnowledgeView({ active, pageNotice, inbox }: { active: boolean; pageNotice?: ReactNode; inbox?: ReturnType<typeof useKnowledgeInbox> }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [readerEpoch, setReaderEpoch] = useState(0);
  const [editing, setEditing] = useState(false);
  const [maintaining, setMaintaining] = useState(false);
  const [editChoice, setEditChoice] = useState<string | null>(null);
  const [incomingId, setIncomingId] = useState<string | null>(null);
  const [collectionTarget, setCollectionTarget] = useState<"capture" | "edit" | null>(null);
  const [targetDraftId, setTargetDraftId] = useState<string | null>(null);
  const [appliedIncomingId, setAppliedIncomingId] = useState<string | null>(null);
  const [pickFinished, setPickFinished] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [collectionError, setCollectionError] = useState("");
  const seenIncoming = useRef(new Set<string>());
  const collectionBusy = useRef(false);
  const appliedCollections = useRef(new Map<string, { target: "capture" | "edit"; draftId: string; durable: boolean }>());
  const [view, setView] = useState<"recent" | "common" | "all">("recent");
  const [query, setQuery] = useState("");
  const [folder, setFolder] = useState("all");
  const [tag, setTag] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [draftChoice, setDraftChoice] = useState(false);
  const [savedNotice, setSavedNotice] = useState<MobileFeedback | undefined>();
  const listScroll = useRef<HTMLDivElement>(null);
  const previousNote = useRef<string | null>(null);
  const savedScroll = useRef(0);
  const draft = useKnowledgeDraft(active);
  const edit = useKnowledgeEdit(active);
  const list = useKnowledgeList(active && !editing && !maintaining, { query, view, folder_filter: folder, tag_ids: tag ? [tag] : [] });
  const incoming = inbox?.items.find(item => item.id === incomingId) || null;
  useEffect(() => {
    const first = inbox?.items[inbox.items.length - 1];
    if (!active || !first || editing || maintaining || !draft.ready || seenIncoming.current.has(first.id)) return;
    seenIncoming.current.add(first.id); setIncomingId(first.id); setCollectionTarget(null);
  }, [active, inbox?.items, editing, maintaining, draft.ready]);
  const resetScroll = () => { if (listScroll.current) listScroll.current.scrollTop = 0; savedScroll.current = 0; };
  const open = (id: string) => {
    savedScroll.current = listScroll.current?.scrollTop ?? savedScroll.current;
    previousNote.current = id; setSavedNotice(undefined); setSelected(id);
  };
  // Keep loaded pages/order on return; otherwise page two disappears and scroll is clamped.
  const back = () => { setSelected(null); setSavedNotice(undefined); };
  useLayoutEffect(() => {
    if (selected || editing || !listScroll.current) return;
    listScroll.current.scrollTop = savedScroll.current;
    if (previousNote.current) [...listScroll.current.querySelectorAll<HTMLButtonElement>("[data-note-id]")].find(button => button.dataset.noteId === previousNote.current)?.focus({ preventScroll: true });
  }, [selected, editing]);
  const start = async () => {
    if (draft.draft) { setDraftChoice(true); return; }
    if (await draft.begin()) { setEditing(true); setSelected(null); }
  };
  const startEdit = async (id: string) => {
    if (edit.draft && edit.draft.note_id !== id) { setEditChoice(id); return false; }
    if (!await edit.begin(id)) return false;
    setMaintaining(true); return true;
  };
  const pickImages = async (target: "capture" | "edit" | null) => {
    if (!inbox || inbox.picking) return;
    setCollectionError(""); setCollectionTarget(target);
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
      seenIncoming.current.add(item.id); setIncomingId(item.id);
      setCollectionTarget(sameDraft ? context.target : null); setTargetDraftId(sameDraft ? context.draftId : null);
      setAppliedIncomingId(appliedCollections.current.has(item.id) ? item.id : null);
      if (!sameDraft) setCollectionError("原草稿已经变化，图片已单独保留，没有加入另一份草稿。");
      pickContext.current = null;
    }
  }, [inbox?.items, inbox?.pickedId, pickFinished, draft.draft?.id, edit.draft?.id]);
  const collect = async (item: MobileKnowledgeIncoming) => {
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
      } else if (collectionTarget === "edit") {
        if (!edit.draft || edit.locked || edit.saving) throw new Error("草稿正在保存");
        if (edit.draft.id !== targetDraftId) throw new Error("原修改草稿已变化，图片仍保留在待收集内容中");
        edit.update("content", knowledgeCollectedContent(item.text, item.images, edit.draft.content));
        appliedCollections.current.set(item.id, { target: "edit", draftId: edit.draft.id, durable: false }); setAppliedIncomingId(item.id); await edit.flush();
        appliedCollections.current.get(item.id)!.durable = true;
      } else if (collectionTarget === "capture") {
        if (!draft.draft || draft.locked || draft.saving) throw new Error("草稿正在保存");
        if (draft.draft.id !== targetDraftId) throw new Error("原记录草稿已变化，图片仍保留在待收集内容中");
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
      if (!await inbox.acknowledge(item.id)) setCollectionError("内容已保留为手机草稿，收集状态未能清理。可以继续写，稍后重试清理。");
      else { appliedCollections.current.delete(item.id); setAppliedIncomingId(null); setIncomingId(null); setCollectionTarget(null); }
    } catch (cause) { setCollectionError(knowledgeErrorText(cause)); }
    finally { collectionBusy.current = false; setCollecting(false); }
  };
  const chooseCollection = (id: string) => { setIncomingId(id); setCollectionTarget(null); setTargetDraftId(null); setCollectionError(""); setAppliedIncomingId(appliedCollections.current.has(id) ? id : null); };
  const showCollection = () => { const latest = inbox?.items[inbox.items.length - 1]; if (latest) chooseCollection(latest.id); };
  const collectionNotice = !!inbox?.items.length && <MobileNotice compact title={`有 ${inbox.items.length} 条待收集内容`} detail="当前输入仍保留。" action={<button className={ui.textButton} onClick={showCollection}>查看收集内容</button>} />;
  const operationNotice: MobileFeedback | undefined = inbox?.error ? { tone: "error", title: "收集操作未能完成", detail: inbox.error } : inbox?.processing ? { tone: "pending", title: "正在整理分享内容…" } : inbox?.notice ? { tone: "info", title: "收集提示", detail: inbox.notice } : undefined;
  const clear = () => { setQuery(""); setFolder("all"); setTag(""); resetScroll(); };
  return <div className={styles.root}>
    <div className={styles.workspace} data-reading={!!selected} hidden={editing || maintaining}>
      <section className={styles.listPane} aria-label="知识库笔记列表">
        <header className={styles.head}><h1 data-mobile-page-title>知识库</h1>
          <button className={ui.textButton} disabled={!draft.ready || draft.saving} onClick={() => void start()}><Plus size={20} aria-hidden="true" />新建</button>
        </header>
        <div className={styles.scroll} ref={listScroll}>
          {pageNotice}
          {!draft.ready && draft.error && <MobileNotice error title="草稿暂时无法读取" detail={draft.error} action={<button className={ui.textButton} onClick={() => void draft.retryLoad()}>重新读取草稿</button>} />}
          {draft.draft && <MobileNotice title="有一份未完成草稿" detail={draft.draft.title || "未命名记录"} action={<button className={ui.textButton} onClick={() => { setEditing(true); setSelected(null); }}>继续写</button>} />}
          {!edit.ready && edit.error && <MobileNotice error title="修改草稿暂时无法读取" detail={edit.error} action={<button className={ui.textButton} onClick={() => void edit.retryLoad()}>重新读取</button>} />}
          {edit.draft && <MobileNotice title="有一份未完成的修改" detail={edit.draft.title} action={<button className={ui.textButton} onClick={() => setMaintaining(true)}>继续修改</button>} />}
          {inbox?.processing && <MobileNotice tone="pending" title="正在整理分享内容…" />}
          {inbox?.error && <MobileNotice error title="待收集内容暂不可用" detail={inbox.error} action={<button className={ui.textButton} onClick={() => void inbox.refresh()}>重新读取</button>} />}
          {inbox?.notice && <MobileNotice title="收集提示" detail={inbox.notice} />}
          {!!inbox?.items.length && <MobileNotice title={`有 ${inbox.items.length} 条待收集内容`} detail="先预览再继续记录，已有草稿会保留。" action={<button className={ui.textButton} onClick={showCollection}>查看收集内容</button>} />}
          <KnowledgeList items={list.items} loading={list.loading} error={list.error} cancelled={list.cancelled} scrollElement={listScroll} onCancel={list.cancel} hasMore={list.hasMore} view={view} query={query} folder={folder} tag={tag} selected={selected}
            onQuery={value => { setQuery(value); resetScroll(); }} onView={value => { setView(value); resetScroll(); }} onFilter={() => setFilterOpen(true)}
            onClear={clear} onOpen={open} onRetry={list.refresh} onMore={() => void list.more()} onNew={() => void start()} />
          {inbox && <button className={ui.secondary} disabled={inbox.picking} onClick={() => void pickImages(null)}>{inbox.picking ? "正在选择图片…" : "从手机收集图片"}</button>}
          <KnowledgeSync active={active && !editing && !maintaining} onChanged={list.refresh} />
        </div>
      </section>
      {selected && <div className={styles.readerPane}><KnowledgeReader key={`${selected}:${readerEpoch}`} noteId={selected} active={active && !editing && !maintaining && !incoming} onBack={back} onOpenNote={open} onEdit={startEdit}
        onCommonChanged={list.refresh} initialNotice={savedNotice} /></div>}
    </div>
    {editing && <KnowledgeEditor draft={draft} active={active && !incoming} onPickImages={inbox ? () => void pickImages("capture") : undefined} operationNotice={operationNotice} collectionNotice={collectionNotice} onBack={() => { setEditing(false); list.refresh(); }} onSaved={id => {
      setSavedNotice({ tone: "success", title: "已保存到手机", detail: "本机保存已完成。电脑是否同步成功，请查看知识库同步状态。" });
      setEditing(false); setSelected(id); list.refresh();
      // Newly saved captures must also appear in phone-local recent reading.
      // Reader owns any position-write failure feedback; list invalidation waits for persistence.
      void mobileKnowledgeVisit(id, 0).then(list.refresh).catch(() => undefined);
    }} />}
    {maintaining && <KnowledgeEditPanel edit={edit} active={active && !incoming} onPickImages={inbox ? () => void pickImages("edit") : undefined} operationNotice={operationNotice} collectionNotice={collectionNotice} onBack={() => { setMaintaining(false); list.refresh(); }} onSaved={(id, copied, relinked) => {
      setSavedNotice({ tone: "success", title: copied ? "手机修改已另存一篇" : "修改已保存到手机", detail: `${relinked ? `已更新 ${relinked} 篇关联笔记的标题链接。` : ""}电脑同步结果请查看同步状态。` });
      setReaderEpoch(v => v + 1); setMaintaining(false); setSelected(id); list.refresh();
    }} />}
    <KnowledgeFilters open={filterOpen && active && !editing && !maintaining} folder={folder} tag={tag} onClose={() => setFilterOpen(false)} onApply={(f, t) => { setFolder(f); setTag(t); setFilterOpen(false); resetScroll(); }} />
    <MobileSheet open={draftChoice && active} title="先处理未完成的草稿" onClose={() => setDraftChoice(false)}>
      <p className={ui.description}>继续编辑可保留当前内容。新建前放弃草稿，会移除这份未完成记录。</p>
      <button className={ui.primary} onClick={() => { setDraftChoice(false); setEditing(true); setSelected(null); }}>继续已有草稿</button>
      <button className={ui.secondary} disabled={draft.saving || draft.locked} onClick={async () => {
        if (!await draft.discard()) return;
        if (await draft.begin()) { setDraftChoice(false); setEditing(true); setSelected(null); }
      }}>放弃草稿并新建</button>
      {draft.error && <MobileNotice error title="草稿仍保留" detail={draft.error} />}
    </MobileSheet>
    <MobileSheet open={!!editChoice && active} title="先处理未完成的修改" onClose={() => setEditChoice(null)} footer={edit.error ? <MobileNotice error title="修改草稿仍保留" detail={edit.error} /> : undefined}>
      <p className={ui.description}>已有修改：{edit.draft?.title}。不会用另一篇笔记覆盖它。</p>
      <button className={ui.primary} onClick={() => { setEditChoice(null); setMaintaining(true); }}>继续已有修改</button>
      <button className={ui.secondary} disabled={edit.saving || edit.locked} onClick={async () => { const id = editChoice; if (id && await edit.discard() && await edit.begin(id)) { setEditChoice(null); setMaintaining(true); } }}>放弃原修改并编辑这篇</button>
    </MobileSheet>
    <KnowledgeCollectionSheet item={incoming} items={inbox?.items} onChoose={chooseCollection} active={active} busy={collecting || !!inbox?.busy} error={collectionError || inbox?.error || ""} hasCapture={!!draft.draft && draft.draft.id !== incoming?.id} target={collectionTarget} applied={appliedIncomingId === incoming?.id} onClose={() => { setIncomingId(null); setCollectionTarget(null); }} onUse={collect} onContinue={() => { setIncomingId(null); setEditing(true); setMaintaining(false); setSelected(null); }} onDiscard={async id => {
      if (inbox && await inbox.acknowledge(id)) { appliedCollections.current.delete(id); setAppliedIncomingId(null); setIncomingId(null); setCollectionTarget(null); }
    }} />
  </div>;
}
