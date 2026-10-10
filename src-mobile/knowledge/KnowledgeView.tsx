import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Plus, Pencil, Link, Image } from "lucide-react";
import { mobileKnowledgeVisit } from "@/lib/api/mobileKnowledge";
import { MobileNotice, type MobileFeedback } from "../ui/MobileNotice";
import { MobileSheet } from "../ui/MobileSheet";
import { MobileToast } from "../ui/MobileToast";
import { KnowledgePending } from "./KnowledgePending";
import { KnowledgeList } from "./KnowledgeList";
import { KnowledgeFilters } from "./KnowledgeFilters";
import { KnowledgeEditor } from "./KnowledgeEditor";
import { KnowledgeReader } from "./KnowledgeReader";
import { KnowledgeSync } from "./KnowledgeSync";
import { useKnowledgeList } from "./useKnowledgeList";
import { useKnowledgeDraft } from "./useKnowledgeDraft";
import { useKnowledgeEdit } from "./useKnowledgeEdit";
import type { useKnowledgeInbox } from "./useKnowledgeInbox";
import { KnowledgeEditPanel } from "./KnowledgeEditPanel";
import { useKnowledgeCollection } from "./useKnowledgeCollection";
import { KnowledgeCollectionSheet } from "./KnowledgeCollectionSheet";
import { useKnowledgeArticle } from "./useKnowledgeArticle";
import { KnowledgeArticleView } from "./KnowledgeArticleView";
import { knowledgeArticleUrl } from "@/lib/utils";
import ui from "../ui/MobileUi.module.css";
import styles from "./KnowledgeView.module.css";
import { useTaskScene } from "../ui/MobileScene";

export function KnowledgeView({ active, pageNotice, inbox, onTaskChange }: { onTaskChange?: (focused: boolean) => void; active: boolean; pageNotice?: ReactNode; inbox?: ReturnType<typeof useKnowledgeInbox> }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [readerEpoch, setReaderEpoch] = useState(0);
  const [editing, setEditing] = useState(false);
  const [maintaining, setMaintaining] = useState(false);
  const [editChoice, setEditChoice] = useState<string | null>(null);
  const [view, setView] = useState<"recent" | "common" | "all">("recent");
  const [query, setQuery] = useState("");
  const [folder, setFolder] = useState("all");
  const [tag, setTag] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [draftChoice, setDraftChoice] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [dismissedInboxNotice, setDismissedInboxNotice] = useState("");
  useEffect(() => setDismissedInboxNotice(""), [inbox?.notice]);
  const [savedNotice, setSavedNotice] = useState<MobileFeedback | undefined>();
  const listScroll = useRef<HTMLDivElement>(null);
  const previousNote = useRef<string | null>(null);
  const savedScroll = useRef(0);
  const draft = useKnowledgeDraft(active);
  const edit = useKnowledgeEdit(active);
  const article = useKnowledgeArticle(active, inbox, (id, title) => {
    setSavedNotice({ tone: "success", title }); setEditing(false); setMaintaining(false); setSelected(id); setReaderEpoch(v=>v+1);
    list.refresh(); void mobileKnowledgeVisit(id, 0).then(list.refresh).catch(() => undefined);
  });
  const focused = !!selected || editing || maintaining || article.open;
  const taskRoot = useRef<HTMLDivElement>(null);
  useTaskScene(taskRoot, article.open ? "article" : maintaining ? "edit" : editing ? "new" : selected ? `read:${selected}` : "list", active);
  useEffect(() => { onTaskChange?.(focused); }, [focused, onTaskChange]);
  useEffect(() => () => onTaskChange?.(false), [onTaskChange]);
  const list = useKnowledgeList(active && !editing && !maintaining && !article.open, { query, view, folder_filter: folder, tag_ids: tag ? [tag] : [] });
  const resetScroll = () => { if (listScroll.current) listScroll.current.scrollTop = 0; savedScroll.current = 0; };
  const rememberScroll = () => {
    // Hidden list panes report zero: only capture while the list is the current task.
    if (!focused) savedScroll.current = listScroll.current?.scrollTop ?? savedScroll.current;
  };
  const open = (id: string) => {
    rememberScroll();
    previousNote.current = id; setSavedNotice(undefined); setSelected(id);
  };
  // Keep loaded pages/order on return; otherwise page two disappears and scroll is clamped.
  const back = () => { setSelected(null); setSavedNotice(undefined); };
  useLayoutEffect(() => {
    if (selected || editing || maintaining || article.open || !listScroll.current) return;
    listScroll.current.scrollTop = savedScroll.current;
    if (previousNote.current) [...listScroll.current.querySelectorAll<HTMLButtonElement>("[data-note-id]")].find(button => button.dataset.noteId === previousNote.current)?.focus({ preventScroll: true });
  }, [selected, editing, maintaining, article.open]);
  const start = async () => {
    rememberScroll();
    if (draft.draft) { setDraftChoice(true); return; }
    if (await draft.begin()) { setEditing(true); setSelected(null); }
  };
  const startEdit = async (id: string) => {
    if (edit.draft && edit.draft.note_id !== id) { setEditChoice(id); return false; }
    if (!await edit.begin(id)) return false;
    setMaintaining(true); return true;
  };
  const collection = useKnowledgeCollection({ active, editing, maintaining, draft, edit, inbox, setEditing, setMaintaining, setSelected, onCaptured: id => {
    rememberScroll(); setSavedNotice({ tone: "success", title: "已保存到手机" }); setSelected(id); list.refresh();
    void mobileKnowledgeVisit(id, 0).then(list.refresh).catch(() => undefined);
  } });
  const { incoming, collectionTarget, appliedIncomingId, collecting, collectionError, pickImages, collect, chooseCollection, showCollection } = collection;
  useEffect(() => {
    if (!active || article.open || !incoming || collectionTarget || appliedIncomingId || incoming.images.length || incoming.status !== "ready") return;
    const url = knowledgeArticleUrl(incoming.text);
    if (!url) return;
    rememberScroll(); collection.close(); void article.begin(url, incoming);
  }, [active, article, incoming, collectionTarget, appliedIncomingId, collection]);
  const collectionNotice = <>{collection.collectionSuccess && <MobileToast placement="flow" compact tone="success" title={collection.collectionSuccess} onDismiss={collection.dismissSuccess} />}{!!inbox?.items.length && <MobileNotice compact title={`有 ${inbox.items.length} 条待收集内容`} detail="当前输入仍保留。" action={<button className={ui.textButton} onClick={showCollection}>查看收集内容</button>} />}</>;
  const operationNotice: MobileFeedback | undefined = inbox?.error ? { tone: "error", title: "收集操作未能完成", detail: inbox.error } : inbox?.processing ? { tone: "pending", title: "正在整理分享内容…" } : inbox?.notice ? { tone: "info", title: "收集提示", detail: inbox.notice } : undefined;
  const clear = () => { setQuery(""); setFolder("all"); setTag(""); resetScroll(); };
  return <div ref={taskRoot} className={styles.root} data-mobile-task-root>
    <div className={styles.root} hidden={article.open}>
    <div className={styles.workspace} data-reading={!!selected} hidden={editing || maintaining}>
      <section className={styles.listPane} aria-label="知识库笔记列表">
        <header className={styles.head}><h1 data-mobile-page-title>知识库</h1>
          <button className={ui.textButton} disabled={!draft.ready || draft.saving} onClick={() => { rememberScroll(); setNewOpen(true); }}><Plus size={20} aria-hidden="true" />新建</button>
        </header>
        <div className={styles.syncSummary}><KnowledgeSync active={active && !editing && !maintaining && !article.open} onChanged={list.refresh} /></div>
        <div className={styles.scroll} ref={listScroll}>
          {pageNotice}
          {article.error && !article.open && <MobileNotice compact tone="warning" title="待收集文章仍保留" detail={article.error} action={<button className={ui.textButton} onClick={() => void article.refresh()}>重新读取</button>} />}
          {!draft.ready && draft.error && <MobileNotice error title="草稿暂时无法读取" detail={draft.error} action={<button className={ui.textButton} onClick={() => void draft.retryLoad()}>重新读取草稿</button>} />}
          {!edit.ready && edit.error && <MobileNotice error title="修改草稿暂时无法读取" detail={edit.error} action={<button className={ui.textButton} onClick={() => void edit.retryLoad()}>重新读取</button>} />}
          {inbox?.processing && <MobileNotice tone="pending" title="正在整理分享内容…" />}
          {inbox?.error && <MobileNotice error title="待收集内容暂不可用" detail={inbox.error} action={<button className={ui.textButton} onClick={() => void inbox.refresh()}>重新读取</button>} />}
          {inbox?.notice && dismissedInboxNotice !== inbox.notice && <MobileToast placement="flow" compact tone="info" title="收集提示" detail={inbox.notice} onDismiss={() => setDismissedInboxNotice(inbox.notice)} />}
          <KnowledgePending active={active && !editing && !maintaining && !article.open}
            draft={draft.draft ? { id: draft.draft.id, title: draft.draft.title, busy: draft.saving, locked: draft.locked, error: draft.error, discard: draft.discard, resume: () => { rememberScroll(); setEditing(true); setSelected(null); } } : undefined}
            edit={edit.draft ? { id: edit.draft.id, title: edit.draft.title, busy: edit.saving, locked: edit.locked, error: edit.error, discard: edit.discard, resume: () => { rememberScroll(); setMaintaining(true); } } : undefined}
            articles={article.pending} incoming={inbox?.items || []}
            onArticle={id => { rememberScroll(); void article.begin(undefined, undefined, id); }} onIncoming={() => { rememberScroll(); showCollection(); }} />
          <KnowledgeList items={list.items} loading={list.loading} error={list.error} cancelled={list.cancelled} scrollElement={listScroll} onCancel={list.cancel} hasMore={list.hasMore} view={view} query={query} folder={folder} tag={tag} selected={selected}
            onQuery={value => { setQuery(value); resetScroll(); }} onView={value => { setView(value); resetScroll(); }} onFilter={() => setFilterOpen(true)}
            onClear={clear} onOpen={open} onRetry={list.refresh} onMore={() => void list.more()} onNew={() => { rememberScroll(); setNewOpen(true); }} />
        </div>
      </section>
      {selected && <div className={styles.readerPane}><KnowledgeReader key={`${selected}:${readerEpoch}`} noteId={selected} active={active && !editing && !maintaining && !incoming && !article.open} onBack={back} onOpenNote={open} onEdit={startEdit} onFillArticle={id => void article.begin(undefined, undefined, id)}
        onCommonChanged={list.refresh} initialNotice={savedNotice} /></div>}
    </div>
    {editing && <KnowledgeEditor draft={draft} active={active && !incoming && !article.open} onPickImages={inbox ? () => void pickImages("capture") : undefined} operationNotice={operationNotice} collectionNotice={collectionNotice} onBack={() => { setEditing(false); list.refresh(); }} onSaved={id => {
      collection.noteSaved(id);
      setSavedNotice({ tone: "success", title: "已保存到手机", detail: "本机保存已完成。电脑同步结果请查看同步状态。" });
      setEditing(false); setSelected(id); list.refresh();
      // Newly saved captures must also appear in phone-local recent reading.
      // Reader owns any position-write failure feedback; list invalidation waits for persistence.
      void mobileKnowledgeVisit(id, 0).then(list.refresh).catch(() => undefined);
    }} />}
    {maintaining && <KnowledgeEditPanel edit={edit} active={active && !incoming && !article.open} onPickImages={inbox ? () => void pickImages("edit") : undefined} operationNotice={operationNotice} collectionNotice={collectionNotice} onBack={() => { setMaintaining(false); list.refresh(); }} onSaved={(id, copied, relinked) => {
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
    <KnowledgeCollectionSheet item={incoming} items={inbox?.items} onChoose={chooseCollection} active={active && !article.open} busy={collecting || !!inbox?.busy} error={collectionError || inbox?.error || ""} hasCapture={!!draft.draft && draft.draft.id !== incoming?.id} target={collectionTarget} applied={appliedIncomingId === incoming?.id} saved={collection.appliedSaved} savePending={collection.savePending} onClose={collection.close} onUse={item => collect(item)} onSave={item => collect(item, true)} onContinue={() => { collection.close(); setEditing(true); setMaintaining(false); setSelected(null); }} onDiscard={collection.discard} />
    <MobileSheet open={newOpen && active} title="新建" onClose={() => setNewOpen(false)}>
      <div className={styles.newActions}>
      <button className={ui.secondary} onClick={() => { setNewOpen(false); void start(); }}><Pencil size={20} aria-hidden="true" />写笔记</button>
      <button className={ui.secondary} onClick={() => { setNewOpen(false); void article.begin(); }}><Link size={20} aria-hidden="true" />收藏文章</button>
      {inbox && <button className={ui.secondary} disabled={inbox.picking} onClick={() => { setNewOpen(false); void pickImages(null); }}><Image size={20} aria-hidden="true" />收集图片</button>}
      </div>
    </MobileSheet>
    </div>
    {article.open && <KnowledgeArticleView article={article} active={active} />}
  </div>;
}
