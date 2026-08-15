/**
 * DocEditor.tsx — 结构化文档三态编辑器（P4）。
 *
 * 三态：原文（渲染后的 HTML）/ 清洗（纯文本）/ Markdown（可编辑 GFM 源码）。
 * 复制/粘贴按当前态自动分流：原文态走 CF_HTML 富格式，其余走纯文本。
 * 保存把原始 mso 噪声 HTML 替换为白名单清洗后的干净 HTML（content+text 同步）。
 *
 * 与 RichEditor 的区别：rich 是 Tiptap WYSIWYG 图文编辑；doc 不编辑 HTML 本身，
 * 只提供"看原文/看纯文本/编辑 Markdown 再输出"三种视角。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { useToast } from "@/components/Toast";
import { useAppStore } from "@/stores/appStore";
import type { EditorProps } from "@/lib/editorRegistry";
import { sanitizeDocHtml, htmlToMarkdown } from "@/lib/docPipeline";
import { copyRichOnly, pasteRichGuarded, copyOnly, pasteTextGuarded } from "@/lib/api";
import { relativeTime } from "@/lib/utils";
import styles from "./DocEditor.module.css";

type Tab = "render" | "plain" | "md";

export function DocEditor({ item, registerActions }: EditorProps) {
  const { toast } = useToast();
  const originalHtml = item.content || "";
  const plainText = item.text || "";

  // 三态内容（原文清洗 / 纯文本 / Markdown）—— useMemo 保证只算一次
  const sanitizedHtml = useMemo(() => sanitizeDocHtml(originalHtml), [originalHtml]);
  const initialMarkdown = useMemo(() => {
    try { return htmlToMarkdown(originalHtml); } catch { return ""; }
  }, [originalHtml]);
  const [markdown, setMarkdown] = useState(initialMarkdown);
  const [mdEdited, setMdEdited] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("render");

  // ref 供 registerActions 的闭包读取最新值
  const tabRef = useRef(activeTab); tabRef.current = activeTab;
  const mdRef = useRef(markdown); mdRef.current = markdown;
  const htmlRef = useRef(sanitizedHtml); htmlRef.current = sanitizedHtml;
  const mdEditedRef = useRef(mdEdited); mdEditedRef.current = mdEdited;

  const isDirty = useCallback(
    () => mdEditedRef.current,
    []
  );

  const save = useCallback(async (): Promise<boolean> => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const stored = htmlRef.current;
      await invoke("update_history_rich", { id: item.id, htmlFragment: stored, plainText });
      useAppStore.setState((s) => ({
        history: s.history.map((h) =>
          h.id === item.id ? { ...h, content: stored, md5: undefined } : h
        ),
        _filterCache: null,
      }));
      // 保存后重置 MD 编辑态并同步到清洗后 HTML 转出的新 MD（避免 MD 态陈旧）
      setMdEdited(false);
      try { setMarkdown(htmlToMarkdown(stored)); } catch { /* ignore */ }
      toast("已保存（已清洗）", "success");
      return true;
    } catch (e) {
      toast("保存失败: " + (e instanceof Error ? e.message : String(e)), "error");
      return false;
    }
  }, [item.id, plainText, toast]);

  const copy = useCallback(async () => {
    const tab = tabRef.current;
    try {
      if (tab === "render") {
        await copyRichOnly(htmlRef.current, plainText);
        toast("已复制富格式", "success");
      } else if (tab === "plain") {
        await copyOnly(plainText);
        toast("已复制纯文本", "success");
      } else {
        await copyOnly(mdRef.current);
        toast("已复制 Markdown", "success");
      }
    } catch (e) {
      toast("复制失败: " + (e instanceof Error ? e.message : String(e)), "error");
    }
  }, [plainText, toast]);

  const paste = useCallback(async () => {
    const tab = tabRef.current;
    try {
      if (tab === "render") {
        const ok = await pasteRichGuarded(htmlRef.current, plainText);
        if (ok) toast("已粘贴富格式", "success");
      } else if (tab === "plain") {
        const ok = await pasteTextGuarded(plainText);
        if (ok) toast("已粘贴纯文本", "success");
      } else {
        const ok = await pasteTextGuarded(mdRef.current);
        if (ok) toast("已粘贴 Markdown", "success");
      }
    } catch (e) {
      toast("粘贴失败: " + (e instanceof Error ? e.message : String(e)), "error");
    }
  }, [plainText, toast]);

  useEffect(() => {
    registerActions({ save, copy, paste, isDirty });
  });

  const hasTable = /<table/i.test(originalHtml);

  // tab 字数计数（清洗/Markdown 显示，1.2k 格式；原文是渲染视图无字数）
  const fmtCount = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));

  // 空态：原文/清洗都没有可显示的内容（md 态是可编辑入口，不归空态）
  const isEmpty = !sanitizedHtml.trim() && !plainText.trim();

  // 空态引导（原文/清洗共用）
  const EmptyHint = (
    <div className={styles.empty}>
      <span className={styles.emptyIcon}>📄</span>
      <span>此文档没有可显示的内容</span>
      <span className={styles.emptySub}>可切换到 Markdown 态编辑</span>
    </div>
  );

  return (
    <>
      <div className={styles.metaBar}>
        <span className={styles.badge}>📄 文档</span>
        {hasTable && <span className={styles.metaInfo}>含表格</span>}
        {sanitizedHtml !== originalHtml && <span className={styles.dirty}>可清洗</span>}
        {(item.source || item.time) && (
          <>
            <span className={styles.metaDiv} />
            <span className={styles.metaSrc}>
              {item.source && `📋 ${item.source}`}
              {item.source && item.time && " · "}
              {item.time && relativeTime(item.time)}
            </span>
          </>
        )}
        <button
          type="button"
          className={styles.fullscreenBtn}
          title="全屏"
          onClick={async () => {
            try {
              const { invoke } = await import("@tauri-apps/api/core");
              await invoke("open_fullscreen_editor", {
                sourceId: item.id, content: htmlRef.current,
                contentType: item.type, language: null,
              });
            } catch { /* 全屏失败不报错，弹窗内继续用 */
            }
          }}
        >
          ⤢ 全屏
        </button>
      </div>

      <div className={styles.tabs}>
        {(["render", "plain", "md"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            className={`${styles.tab}${activeTab === t ? ` ${styles.tabActive}` : ""}`}
            onClick={() => setActiveTab(t)}
          >
            {t === "render" ? "📄 原文" : t === "plain" ? "📃 清洗" : "✍️ Markdown"}
            {t === "plain" && <span className={styles.tabCount}>{fmtCount(plainText.length)}</span>}
            {t === "md" && <span className={styles.tabCount}>{fmtCount(markdown.length)}</span>}
          </button>
        ))}
      </div>

      <div className={styles.content}>
        <div className={styles.paper}>
          {activeTab === "render" && (
            isEmpty ? EmptyHint : (
              <div
                className={styles.rendered}
                dangerouslySetInnerHTML={{
                  __html: DOMPurify.sanitize(sanitizedHtml, { ADD_ATTR: ["colspan", "rowspan"] }),
                }}
              />
            )
          )}
          {activeTab === "plain" && (
            isEmpty ? EmptyHint : <pre className={styles.plainText}>{plainText}</pre>
          )}
          {activeTab === "md" && (
            <textarea
              className={styles.mdEdit}
              value={markdown}
              spellCheck={false}
              onChange={(e) => { setMarkdown(e.target.value); setMdEdited(true); }}
            />
          )}
        </div>
      </div>
    </>
  );
}
