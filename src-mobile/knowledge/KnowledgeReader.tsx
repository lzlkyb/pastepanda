import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, Copy, List, MoreHorizontal, Star, Pencil, Share2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { copyToClipboard, knowledgeErrorText } from "@/lib/utils";
import { mobileKnowledgeResolve, mobileKnowledgeSetCommon, type MobileNoteSummary } from "@/lib/api/mobileKnowledge";
import { MobileNotice, type MobileFeedback } from "../ui/MobileNotice";
import { MobileToast } from "../ui/MobileToast";
import { MobileSheet } from "../ui/MobileSheet";
import { useMobileBack } from "../ui/useMobileBack";
import { KnowledgeMarkdown, type KnowledgeHeading } from "./KnowledgeMarkdown";
import { useKnowledgeReading } from "./useKnowledgeReading";
import { mobileKnowledgeShareSend } from "@/lib/api/mobileKnowledgeShare";
import { KnowledgeAssetSheet } from "./KnowledgeAssetSheet";
import { KnowledgeImageViewer } from "./KnowledgeImageViewer";
import styles from "./KnowledgeReader.module.css";

export function KnowledgeReader({ noteId, onBack, onCommonChanged, active, onOpenNote, initialNotice, onEdit }: {
  noteId: string; onBack: () => void; onCommonChanged?: () => void; active: boolean;
  onOpenNote?: (id: string) => void;
  initialNotice?: MobileFeedback;
  onEdit?: (id: string) => Promise<boolean>;
}) {
  const reading = useKnowledgeReading(noteId, active);
  const { note, meta, setMeta, loading, error, missing, newer } = reading;
  const article = useRef<HTMLDivElement>(null);
  const restored = useRef<string | null>(null);
  const request = useRef(0);
  const linkRequest = useRef(0);
  const [sheet, setSheet] = useState<"toc" | "more" | "link" | null>(null);
  const [feedback, setFeedback] = useState<MobileFeedback | null>(null);
  const [headings, setHeadings] = useState<KnowledgeHeading[]>([]);
  const [commonBusy, setCommonBusy] = useState(false);
  const [copyBusy, setCopyBusy] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkFeedback, setLinkFeedback] = useState<MobileFeedback | null>(null);
  const [url, setUrl] = useState("");
  const [targets, setTargets] = useState<MobileNoteSummary[]>([]);
  const [asset, setAsset] = useState<{ noteId: string; src: string } | null>(null);
  const [image, setImage] = useState<{ src: string; alt: string } | null>(null);
  const reloadImage = useRef<(() => void) | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [localImageCount, setLocalImageCount] = useState(0);
  useMobileBack(active && !sheet && !asset && !image, onBack);
  useEffect(() => {
    ++request.current; ++linkRequest.current; restored.current = null; setSheet(null); setFeedback(initialNotice || null); setHeadings([]);
    setLinkFeedback(null); setTargets([]); setUrl(""); setCopyBusy(false); setCommonBusy(false); setLinkBusy(false);
    setAsset(null); setImage(null); reloadImage.current = null; setActionBusy(false);
  }, [noteId, initialNotice]);
  useEffect(() => { if (!active) {
    ++request.current; ++linkRequest.current; setSheet(null); setCopyBusy(false); setCommonBusy(false); setLinkBusy(false);
    setFeedback(previous => previous?.tone === "pending" ? null : previous);
    setAsset(null); setImage(null); reloadImage.current = null; setActionBusy(false);
  } }, [active]);
  useLayoutEffect(() => {
    if (!note || !meta || restored.current === note.id || !article.current) return;
    restored.current = note.id;
    const element = article.current;
    element.scrollTop = meta.reading_position * Math.max(0, element.scrollHeight - element.clientHeight);
  }, [note, meta]);

  const toggleCommon = async () => {
    if (!note || commonBusy || !meta) return;
    const token = request.current;
    setCommonBusy(true); setFeedback({ tone: "pending", title: "正在更新手机常用…" });
    try {
      const next = await mobileKnowledgeSetCommon(note.id, !meta.common);
      if (token !== request.current) return;
      setMeta(next); onCommonChanged?.();
      setFeedback({ tone: "success", title: next.common ? "已加入手机常用" : "已移出手机常用", detail: "只影响这台手机的列表。" });
    } catch (cause) { if (token === request.current) setFeedback({ tone: "error", title: "未能更新常用", detail: knowledgeErrorText(cause) }); }
    finally { if (token === request.current) setCommonBusy(false); }
  };
  const copyNote = async () => {
    if (!note || copyBusy) return;
    const token = request.current;
    setCopyBusy(true); setFeedback({ tone: "pending", title: "正在复制正文…" });
    const ok = await copyToClipboard(note.content);
    if (token !== request.current) return;
    setCopyBusy(false); setFeedback(ok ? { tone: "success", title: "已复制正文" } : {
      tone: "error", title: "未能复制正文", detail: "请重试，也可关闭面板后长按正文选择文字。",
    });
  };
  const followLink = async (href: string, internal: boolean) => {
    const token = ++linkRequest.current;
    setTargets([]); setUrl(""); setLinkFeedback(null); setLinkBusy(false); setSheet("link");
    if (!internal) {
      if (href.startsWith("#")) {
        const heading = article.current?.querySelector<HTMLElement>(`[id="${href.slice(1).replace(/[^\w-]/g, "")}"]`);
        setSheet(null); if (heading) article.current?.scrollTo({ top: heading.offsetTop - article.current.offsetTop });
        else setFeedback({ tone: "warning", title: "未找到这个章节", detail: "可用目录查看本机正文中的章节。" });
        return;
      }
      try {
        const parsed = new URL(href);
        if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
        setUrl(parsed.href);
      } catch { setLinkFeedback({ tone: "warning", title: "这个链接无法在手机上打开", detail: "支持网页链接；本机文件和应用命令不会自动执行。" }); }
      return;
    }
    setLinkBusy(true); setLinkFeedback({ tone: "pending", title: "正在查找本机笔记…" });
    try {
      const result = await mobileKnowledgeResolve(href);
      if (token !== linkRequest.current) return;
      setTargets(result.items);
      setLinkFeedback(result.items.length ? { tone: "info", title: result.items.length === 1 ? "打开关联笔记" : "有多篇同名笔记，请选择", detail: result.has_more ? "当前显示前 20 篇，可返回搜索缩小范围。" : undefined } : {
        tone: "warning", title: "本机没有找到这篇笔记", detail: "可能还未同步，也可能已改名。返回知识库搜索或同步后再试。",
      });
    } catch (cause) { if (token === linkRequest.current) setLinkFeedback({ tone: "error", title: "未能查找关联笔记", detail: knowledgeErrorText(cause) }); }
    finally { if (token === linkRequest.current) setLinkBusy(false); }
  };
  const openExternal = async () => {
    if (linkBusy || !url) return;
    const token = linkRequest.current; setLinkBusy(true);
    setLinkFeedback({ tone: "pending", title: "正在打开浏览器…" });
    try {
      await openUrl(url);
      if (token === linkRequest.current) setLinkFeedback({ tone: "success", title: "已交给浏览器打开" });
    } catch { if (token === linkRequest.current) setLinkFeedback({ tone: "error", title: "未能打开链接", detail: "请重试，或复制地址后在浏览器中打开。" }); }
    finally { if (token === linkRequest.current) setLinkBusy(false); }
  };
  const shareNote = async (withImages: boolean) => {
    if (!note || actionBusy) return;
    const sources = [...new Set([...article.current?.querySelectorAll<HTMLButtonElement>("[data-local-image]") || []].map(button => button.dataset.localImage || "").filter(Boolean))];
    if (withImages && sources.length > 8) {
      setFeedback({ tone: "warning", title: "这篇笔记图片较多", detail: "一次最多分享8张图片，可以先分享正文文字。原笔记仍保留。" }); return;
    }
    const token = request.current; setActionBusy(true); setFeedback({ tone: "pending", title: "正在打开系统分享…" });
    try {
      await mobileKnowledgeShareSend({ title: note.title, text: `${note.title}\n\n${note.content}`, imageSources: withImages ? sources : [] });
      if (token === request.current) setFeedback({ tone: "success", title: "已打开系统分享", detail: "是否发送成功，请查看接收App的结果。" });
    } catch (cause) { if (token === request.current) setFeedback({ tone: "error", title: "系统分享未能打开", detail: withImages ? "本机图片可能尚未完整。请补齐后重试，或只分享正文文字。" : knowledgeErrorText(cause) }); }
    finally { if (token === request.current) setActionBusy(false); }
  };

  return <section className={styles.reader} aria-label="笔记全文">
    <header className={styles.header}>
      <button type="button" onClick={() => { reading.savePosition(); onBack(); }}><ArrowLeft size={20} aria-hidden="true" /><span>返回</span></button>
      <span className={styles.headerTitle}>知识库</span>
      <button type="button" disabled={!note} onClick={() => { setFeedback(null); setLocalImageCount(article.current?.querySelectorAll("[data-local-image]").length || 0); setSheet("more"); }}><MoreHorizontal size={20} aria-hidden="true" /><span>更多</span></button>
    </header>
    <div ref={article} className={styles.scroll} onScroll={event => reading.onScroll(event.currentTarget)}>
      {loading && !note && <MobileNotice tone="pending" title="正在读取本机正文…" />}
      {error && <MobileNotice tone="error" title="未能读取笔记" detail={reading.errorDetail} action={<button type="button" onClick={() => void reading.reload()}>重试读取</button>} />}
      {!reading.online && note && <MobileNotice compact tone="info" title="正在阅读本机内容" detail="手机当前离线；外部链接和图片可能无法加载。" />}
      {missing && <MobileNotice tone="warning" title="这篇笔记已不在本机知识库中" detail={note ? "当前页面保留已打开的内容，返回后可重新搜索。" : "可能已删除或尚未同步，请返回搜索或检查同步状态。"} />}
      {newer && <MobileNotice tone="info" title="本机正文已更新" detail="继续阅读当前版本，或手动载入新版。" action={<button type="button" onClick={() => void reading.reload()}>载入新版</button>} />}
      {reading.metaError && <MobileNotice tone="warning" title="阅读偏好未能加载" detail="正文仍可阅读；常用状态和上次位置暂不可用。" action={<button type="button" onClick={() => void reading.check()}>重试偏好</button>} />}
      {reading.positionError && <MobileNotice tone="warning" title="阅读位置未能保存" detail="正文仍可阅读，返回此页时可能从开头开始。" action={<button type="button" onClick={reading.savePosition}>重试保存位置</button>} />}
      {note && <article className={styles.article}>
        <p className={styles.meta}>本机内容 · 更新于 {new Date(note.updated_at).toLocaleString()}</p>
        <h1>{note.title || "未命名笔记"}</h1>
        {!!note.tags.length && <p className={styles.tags}>{note.tags.map(tag => <span key={tag.id}>#{tag.name}</span>)}</p>}
        {note.content ? <KnowledgeMarkdown content={note.content} active={active && !image && !sheet} onLink={(href, internal) => void followLink(href, internal)} onHeadings={setHeadings} onMissingImage={(src, reload) => { reloadImage.current = reload; setAsset({ noteId, src }); }} onImage={(src, alt) => setImage({ src, alt })} /> : <p className={styles.meta}>这篇笔记还没有正文。</p>}
      </article>}
    </div>
    <footer className={styles.footer}>
      {!sheet && feedback && (feedback.tone === "success" || feedback.tone === "info"
        ? <MobileToast placement="flow" compact {...feedback} onDismiss={() => setFeedback(null)} />
        : <MobileNotice compact {...feedback} onDismiss={feedback.tone !== "pending" ? () => setFeedback(null) : undefined} />)}
      <div className={styles.footerActions}>
        <button type="button" disabled={!note || !meta || commonBusy || missing} aria-pressed={!!meta?.common} onClick={() => void toggleCommon()}><Star size={20} aria-hidden="true" /><span>{meta?.common ? "手机常用" : "加入手机常用"}</span></button>
        <button type="button" disabled={!note} onClick={() => setSheet("toc")}><List size={20} aria-hidden="true" /><span>目录</span></button>
      </div>
    </footer>
    <MobileSheet open={!!sheet && active} title={sheet === "toc" ? "文章目录" : sheet === "link" ? "打开链接" : "阅读操作"} onClose={() => { ++linkRequest.current; setLinkBusy(false); setSheet(null); }} footer={sheet === "more" && feedback ? (feedback.tone === "success" || feedback.tone === "info" ? <MobileToast placement="flow" compact {...feedback} onDismiss={() => setFeedback(null)} /> : <MobileNotice compact {...feedback} />) : sheet === "link" && linkFeedback ? <MobileNotice {...linkFeedback} /> : undefined}>
      {sheet === "more" && <div className={styles.sheetActions}>
        {onEdit && <button type="button" disabled={actionBusy || missing} onClick={async () => {
          if (!note || actionBusy) return;
          const token = request.current; setActionBusy(true); setFeedback({ tone: "pending", title: "正在准备修改草稿…" });
          try { const opened = await onEdit(note.id); if (!opened && token === request.current) setFeedback({ tone: "warning", title: "修改尚未打开", detail: "请先处理未完成草稿，或返回知识库后重试。已有内容仍保留。" }); }
          catch { if (token === request.current) setFeedback({ tone: "error", title: "修改未能打开", detail: "请重试。原笔记与已有修改草稿仍保留。" }); }
          finally { if (token === request.current) setActionBusy(false); }
        }}><Pencil size={20} aria-hidden="true" /><span>修改笔记</span></button>}
        <button type="button" disabled={actionBusy} onClick={() => void shareNote(false)}><Share2 size={20} aria-hidden="true" /><span>分享正文文字</span></button>
        {localImageCount > 0 && <button type="button" disabled={actionBusy} onClick={() => void shareNote(true)}><Share2 size={20} aria-hidden="true" /><span>分享文字与本机图片</span></button>}
        <button type="button" disabled={copyBusy} onClick={() => void copyNote()}><Copy size={20} aria-hidden="true" /><span>{copyBusy ? "正在复制…" : "复制正文"}</span></button>
        <button type="button" disabled={loading} onClick={() => void reading.check()}>{loading ? "正在检查…" : "检查本机更新"}</button>
        <p className={styles.meta}>此处读取手机上的正文，不表示电脑已收到最新修改。</p>
      </div>}
      {sheet === "toc" && <div className={styles.sheetActions}>{headings.length ? headings.map(heading => <button type="button" key={heading.id} data-depth={heading.depth} onClick={() => {
        setSheet(null); const element = article.current?.querySelector<HTMLElement>(`#${heading.id}`);
        if (element && article.current) article.current.scrollTo({ top: element.offsetTop - article.current.offsetTop, behavior: "auto" });
      }}>{heading.text}</button>) : <p className={styles.meta}>正文没有章节标题，可以直接滚动阅读。</p>}</div>}
      {sheet === "link" && <div className={styles.sheetActions}>
        {url && <><p className={styles.address}>{url}</p><button type="button" disabled={linkBusy} onClick={() => void openExternal()}>在浏览器中打开</button></>}
        {targets.map(target => <button type="button" key={target.id} aria-label={`${target.title} ${target.folder_name || "未分类"} ${target.excerpt || "无正文预览"}`} disabled={!onOpenNote} onClick={() => { reading.savePosition(); setSheet(null); onOpenNote?.(target.id); }}><span>{target.title}</span><small>{target.folder_name || "未分类"} · {target.excerpt || "无正文预览"}</small></button>)}
      </div>}
    </MobileSheet>
    <KnowledgeAssetSheet target={asset} active={active} onClose={() => setAsset(null)} onLoaded={() => reloadImage.current?.()} />
    <KnowledgeImageViewer image={image} active={active} onClose={() => setImage(null)} />
  </section>;
}
