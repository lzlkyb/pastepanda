/**
 * OcrSummaryPanel — 全屏查看层的 OCR 浮出面板（设计稿「C壳+B芯」）。
 *
 * 三态一体（替代旧版「结果栏 + 折叠抽屉 + 下一步工具栏」三层各一套按钮）：
 * - 摘要条（默认）：来自列表缓存的全文直接带出——行数字数 + 首行预览 + 复制/展开；
 * - 选词条（ocrActive 时顶替摘要条）：已选 N 词 + 复制选中/变换为…/搜索/清除；
 * - 展开态：下一步动作一行（复制全部/存为卡片/变换为…/搜索）+ 全文（实体可点）或校对对照。
 * 零二次识别：全文取 ocrResult?.full_text ?? ocrCachedText，不在此触发任何识别。
 */
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/Toast";
import { useAppStore } from "@/stores/appStore";
import { copyToClipboard, extractEntities, type OcrEntity, type OcrEntityType } from "@/lib/utils";
import type { UseImagePreviewReturn } from "@/hooks/useImagePreview";
import styles from "./CardList.module.css";

export interface OcrSummaryPanelProps {
  preview: UseImagePreviewReturn;
  /** 拿文本去变换枢纽（壳层实现：关查看层 + openHub） */
  onOpenHub: (text: string) => void;
  /** selection = 选词条（ocrActive 时）；summary = 摘要/全文（面板互斥中的 "ocr" 槽位）。
   *  由壳层按互斥链决定渲染哪一种——同时最多一个浮层面板。 */
  mode: "selection" | "summary";
}

export function OcrSummaryPanel({ preview, onOpenHub, mode }: OcrSummaryPanelProps) {
  const { toast } = useToast();
  const {
    ocrResult, ocrCachedText, ocrActive, selectedWordIndices,
    setSelectedWordIndices, getSelectedOcrTexts, getSelectedOcrJoined,
  } = preview;

  const [open, setOpen] = useState(false);
  const [ocrEditText, setOcrEditText] = useState("");
  const [ocrEditing, setOcrEditing] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);
  const [copiedSel, setCopiedSel] = useState(false);
  // 微信借鉴① 实体 popover：{ type, value, 相对结果面板的 x/y }；popFeedback 为按钮内联反馈
  const [entityPop, setEntityPop] = useState<{ type: OcrEntityType; value: string; x: number; y: number } | null>(null);
  const [popFeedback, setPopFeedback] = useState<string | null>(null);
  const fullPanelRef = useRef<HTMLDivElement | null>(null);

  const fullText = ocrEditing ? ocrEditText : (ocrResult?.full_text ?? ocrCachedText ?? "");
  const lineCount = ocrResult?.lines.length ?? null;

  useEffect(() => {
    if (ocrResult?.full_text) {
      setOcrEditText(ocrResult.full_text);
      setOcrEditing(false);
    }
  }, [ocrResult?.full_text]);

  // 摘要态且什么文字都没有（未识别 + 失败/空库）= 无内容可展示，零可见
  if (mode === "summary" && ocrCachedText == null && ocrResult == null) return null;

  const flash = (set: (v: boolean) => void) => {
    set(true);
    setTimeout(() => set(false), 1500);
  };

  const handleCopyAll = async () => {
    const ok = await copyToClipboard(fullText);
    if (ok) flash(setCopiedAll);
    else toast("复制失败", "error");
  };

  const handleCopySel = async () => {
    const texts = getSelectedOcrTexts();
    if (texts.length === 0) return;
    const ok = await copyToClipboard(texts.join(" "));
    if (ok) flash(setCopiedSel);
    else toast("复制失败", "error");
  };

  /** 存为卡片：走 appStore.prependItem（纯本地，零出网） */
  const saveOcrAsCard = (text: string) => {
    const t = text.trim();
    if (!t) return;
    const store = useAppStore.getState();
    store.prependItem({
      id: crypto.randomUUID(),
      text: t,
      time: new Date().toISOString(),
      type: "text",
      content: "",
      pinned: false,
      source: "OCR",
      workspace: store.config.current_workspace,
    });
    toast("已存为卡片", "success");
  };

  const handleSearch = async () => {
    const q = ocrActive ? getSelectedOcrJoined() : fullText;
    if (!q) return;
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(`https://www.bing.com/search?q=${encodeURIComponent(q)}`);
    } catch {
      toast("打开搜索失败", "error");
    }
  };

  // ===== 实体高亮：把全文按 extractEntities 切分，URL/电话/邮箱渲染为可点击 span =====
  const renderOcrText = (text: string): React.ReactNode[] => {
    const entities = extractEntities(text);
    if (entities.length === 0) return [text];
    const nodes: React.ReactNode[] = [];
    let cursor = 0;
    entities.forEach((ent, i) => {
      if (ent.start > cursor) nodes.push(text.slice(cursor, ent.start));
      const cls =
        ent.type === "url" ? styles.ocrEntityUrl
        : ent.type === "phone" ? styles.ocrEntityPhone
        : styles.ocrEntityEmail;
      nodes.push(
        <span key={i} className={`${styles.ocrEntity} ${cls}`} onClick={(e) => openEntityPopover(e, ent)}>
          {ent.value}
        </span>,
      );
      cursor = ent.end;
    });
    if (cursor < text.length) nodes.push(text.slice(cursor));
    return nodes;
  };

  const openEntityPopover = (e: React.MouseEvent, ent: OcrEntity) => {
    e.stopPropagation();
    const panel = fullPanelRef.current;
    if (!panel) return;
    const pr = panel.getBoundingClientRect();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // 尽量放在实体下方；接近面板底部时翻到上方，避免浮层出面板被裁
    const below = r.bottom - pr.top + 6;
    const top = below + 150 > pr.height ? r.top - pr.top - 156 : below;
    setEntityPop({ type: ent.type, value: ent.value, x: r.left - pr.left, y: top });
    setPopFeedback(null);
  };

  const handleEntityAction = async (action: "copy" | "open" | "save") => {
    if (!entityPop) return;
    const { type, value } = entityPop;
    if (action === "copy") {
      const ok = await copyToClipboard(value);
      if (ok) {
        setPopFeedback("已复制 ✓");
        setTimeout(() => setEntityPop(null), 900);
      } else toast("复制失败", "error");
    } else if (action === "open") {
      try {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        if (type === "url") await openUrl(value);
        else if (type === "phone") await openUrl(`tel:${value.replace(/[\s-]/g, "")}`);
        else await openUrl(`mailto:${value}`);
        setEntityPop(null);
      } catch {
        toast("打开失败", "error");
      }
    } else {
      saveOcrAsCard(value);
      setEntityPop(null);
    }
  };

  return (
    <div className={styles.fsPanel} ref={fullPanelRef} onClick={(e) => e.stopPropagation()}>
      {mode === "selection" ? (
        <div className={styles.fsPanelHead}>
          <span className={styles.fsPanelTitle}>🔍 已选 <strong>{selectedWordIndices.size}</strong> 个词</span>
          <span className={styles.fsPanelSub}>
            {selectedWordIndices.size > 0 ? getSelectedOcrTexts().join(" ") : "点击图上文字选词，或拖拽框选"}
          </span>
          <span className={styles.fsPanelSp} />
          {selectedWordIndices.size > 0 && (
            <button className={styles.fsPanelBtn} onClick={() => setSelectedWordIndices(new Set())}>清除</button>
          )}
          <button className={styles.fsPanelBtn} disabled={selectedWordIndices.size === 0} onClick={() => void handleCopySel()}>
            {copiedSel ? "✓ 已复制" : "复制选中"}
          </button>
          <button
            className={`${styles.fsPanelBtn} ${styles.fsPanelBtnPri}`}
            disabled={selectedWordIndices.size === 0}
            title="拿选中的文字去翻译 / 解释 / 自定义动作"
            onClick={() => onOpenHub(getSelectedOcrJoined())}
          >
            ✨ 变换为…
          </button>
          <button className={styles.fsPanelBtn} disabled={selectedWordIndices.size === 0} onClick={() => void handleSearch()}>
            🔍 搜索
          </button>
        </div>
      ) : (
        <>
          <div className={styles.fsPanelHead}>
            <span className={styles.fsPanelTitle}>🔍 {lineCount != null ? `识别到 ${lineCount} 行` : "已识别文字"}</span>
            <span className={styles.fsPanelSub}>{fullText.length} 字{ocrResult == null ? " · 来自列表识别" : ""}</span>
            <span className={styles.fsPanelSp} />
            <button className={styles.fsPanelBtn} onClick={() => setOpen((v) => !v)}>
              {open ? "收起 ▾" : "展开校对 ▴"}
            </button>
            <button className={`${styles.fsPanelBtn} ${styles.fsPanelBtnPri}`} onClick={() => void handleCopyAll()}>
              {copiedAll ? "✓ 已复制" : "📋 复制全部"}
            </button>
          </div>
          {!open && <div className={styles.fsPanelPreview}>{fullText.slice(0, 120) || "（未识别到文字）"}</div>}
          {open && (
            <div className={styles.fsPanelBody}>
              <div className={styles.fsPanelActs}>
                <button className={styles.fsPanelBtn} onClick={() => setOcrEditing((v) => !v)}>{ocrEditing ? "完成" : "可编辑"}</button>
                <button className={styles.fsPanelBtn} onClick={() => saveOcrAsCard(fullText)}>💾 存为卡片</button>
                <button className={styles.fsPanelBtn} onClick={() => onOpenHub(fullText)}>✨ 变换为…</button>
                <button className={styles.fsPanelBtn} onClick={() => void handleSearch()}>🔍 搜索</button>
              </div>
              {ocrEditing ? (
                <textarea
                  className={styles.fsPanelEdit}
                  value={ocrEditText}
                  onChange={(e) => setOcrEditText(e.target.value)}
                  spellCheck={false}
                />
              ) : (
                <div className={styles.fsPanelText}>{renderOcrText(ocrResult?.full_text ?? ocrCachedText ?? "")}</div>
              )}
            </div>
          )}
          {entityPop && (
            <div className={`${styles.ocrEntityPop} ${styles.fsEntityPop}`} style={{ left: entityPop.x, top: entityPop.y }} onClick={(e) => e.stopPropagation()}>
              <div className={styles.ocrEntityPopTitle}>
                {entityPop.type === "url" ? "🔗 链接" : entityPop.type === "phone" ? "📞 电话" : "✉️ 邮箱"}
              </div>
              <div className={styles.ocrEntityPopValue}>{entityPop.value}</div>
              <button className={styles.ocrEntityPopBtn} onClick={() => void handleEntityAction("copy")}>{popFeedback || "⧉ 复制"}</button>
              {entityPop.type !== "email" && (
                <button className={styles.ocrEntityPopBtn} onClick={() => void handleEntityAction("open")}>
                  {entityPop.type === "url" ? "↗ 打开链接" : "📞 呼叫"}
                </button>
              )}
              {entityPop.type === "email" && (
                <button className={styles.ocrEntityPopBtn} onClick={() => void handleEntityAction("open")}>✉️ 发邮件</button>
              )}
              <button className={styles.ocrEntityPopBtn} onClick={() => void handleEntityAction("save")}>💾 存为卡片</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
