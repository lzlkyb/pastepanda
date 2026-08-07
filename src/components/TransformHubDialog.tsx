/**
 * TransformHubDialog.tsx — 变换枢纽（卡片流，方案 A）。
 *
 * 由右键「变换为…」经 dialogStore.openHub(item) 打开：
 * 把当前内容命中的所有注册变换（applicableTransforms，按匹配度排序）
 * 逐个渲染为独立卡片——每张卡自带选项 chip、实时预览、复制 / 粘贴按钮。
 *
 * 交互模型（针对"悬停即选中 → 待复制内容被误切换"的修复）：
 * - 没有全局"选中态"，鼠标悬停只高亮卡片边框，不改变任何待复制内容；
 * - 每张卡的复制按钮只复制本卡产物，复制后不关闭，可连续复制多个；
 * - Esc 关闭。
 *
 * 挂载方式仿 ExtractDialog（常挂载 + 内部 AnimatePresence 门控退场动画）。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Copy, Check, X, Sparkles, Database, Table, List, ClipboardPaste,
  CaseUpper, CaseLower, Eraser, Pilcrow, Quote, RemoveFormatting, Link as LinkIcon,
  Globe, Mail, Phone, Code, Minus, Hash, Palette, Folder, FileText,
  type LucideIcon,
} from "lucide-react";
import { useDialogStore } from "@/stores/dialogStore";
import { applicableTransforms, type Transform, type TransformContext, type TransformOptionSpec } from "@/lib/transforms";
import { pasteText } from "@/lib/api";
import { useToast } from "@/components/Toast";
import { useDialogAnim } from "@/lib/dialogMotion";
import { FocusTrap } from "@/components/FocusTrap";
import { MelodyEmpty } from "@/components/MelodyEmpty";
import styles from "./TransformHub.module.css";

/** 图标语义键 → lucide 组件（逻辑层保持纯净，图标在 UI 层映射） */
const ICONS: Record<string, LucideIcon> = {
  database: Database, table: Table, rows: List,
  "case-upper": CaseUpper, "case-lower": CaseLower, eraser: Eraser, pilcrow: Pilcrow,
  quote: Quote, "remove-formatting": RemoveFormatting, link: LinkIcon, globe: Globe,
  mail: Mail, phone: Phone, code: Code, minus: Minus, hash: Hash, palette: Palette,
  folder: Folder, "file-text": FileText,
};

function TIcon({ name, size = 15 }: { name?: string; size?: number }) {
  const C = (name && ICONS[name]) || Sparkles;
  return <C size={size} />;
}

/** 解析变换的选项规格：动态 optionsFor 优先（选项随输入变化），回退静态 options */
function specsFor(t: Transform, ctx: TransformContext): TransformOptionSpec[] {
  return t.optionsFor?.(ctx) ?? t.options ?? [];
}

/** 从选项规格生成默认值表 */
function defaultOptsFromSpecs(specs: TransformOptionSpec[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (const spec of specs) if (spec.default) o[spec.key] = spec.default;
  return o;
}

/** 单个变换卡片：选项 + 预览 + 复制/粘贴，全部自包含、互不干扰 */
function TransformCard({
  t, score, text, opts, html, specs, copied, onSetOpt, onCopy, onPaste,
}: {
  t: Transform;
  score: number;
  text: string;
  opts: Record<string, string>;
  /** P2：doc/rich 条目的 HTML 片段，透传给变换 run() */
  html?: string;
  specs: TransformOptionSpec[];
  copied: boolean;
  onSetOpt: (key: string, value: string) => void;
  onCopy: () => void;
  onPaste: () => void;
}) {
  // 本卡产物：支持同步和异步 run（配置转换调 Rust 侧为异步）
  const [preview, setPreview] = useState<{ ok: boolean; output?: string; message?: string }>({ ok: false, message: "…" });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const result = t.run(text, { ...opts, ...(html ? { html } : {}) });
    if (result instanceof Promise) {
      setLoading(true);
      result.then((r) => {
        if (!cancelled) { setPreview(r); setLoading(false); }
      });
    } else {
      setPreview(result);
    }
    return () => { cancelled = true; };
  }, [t, text, opts, html]);

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.cardIcon}><TIcon name={t.icon} /></span>
        <span className={styles.cardMain}>
          <span className={styles.cardLabel}>{t.label}</span>
          {t.description && <span className={styles.cardDesc}>{t.description}</span>}
        </span>
        <span className={styles.score}>{Math.round(score * 100)}%</span>
      </div>

      {specs.length > 0 && (
        <div className={styles.cardOpts}>
          {specs.map((spec) => (
            <div key={spec.key} className={styles.optGroup}>
              <span className={styles.optLabel}>{spec.label}</span>
              {spec.values.map((v) => (
                <button
                  key={v.value}
                  className={`${styles.chip} ${(opts[spec.key] ?? spec.default) === v.value ? styles.chipOn : ""}`}
                  onClick={() => onSetOpt(spec.key, v.value)}
                >
                  {v.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <pre className={styles.cardPreview}>转换中…</pre>
      ) : preview.ok ? (
        <pre className={styles.cardPreview}>{preview.output}</pre>
      ) : (
        <pre className={styles.previewErr}>{preview.message ?? "无法转换"}</pre>
      )}

      <div className={styles.cardActions}>
        <button
          className={`${styles.copyBtn} ${copied ? styles.copyBtnDone : ""}`}
          onClick={onCopy}
          disabled={!preview.ok}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "已复制" : "复制"}
        </button>
        <button className={styles.pasteBtn} onClick={onPaste} disabled={!preview.ok}>
          <ClipboardPaste size={13} />
          粘贴到前台
        </button>
      </div>
    </div>
  );
}

export function TransformHubDialog() {
  const item = useDialogStore((s) => s.hubItem);
  const open = !!item;
  const anim = useDialogAnim();
  const { toast } = useToast();

  // 每个变换各自维护选项（id → {key: value}），互不影响
  const [opts, setOpts] = useState<Record<string, Record<string, string>>>({});
  // 刚完成复制的卡片（仅用于按钮"已复制"反馈，与选中无关）
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const close = useCallback(() => useDialogStore.getState().closeHub(), []);

  // 变换上下文（动态选项解析的输入，如 SQL IN 的可选字段来自对象数组实际字段）
  const ctx = useMemo<TransformContext>(
    () => ({
      text: item?.text || "",
      contentType: item ? item.content_type || item.type : "",
      // P2 文档管线：doc/rich 条目把 CF_HTML 片段透传给文档类变换
      html: item && (item.type === "doc" || item.type === "rich") ? item.content : undefined,
    }),
    [item],
  );

  // 当前内容命中的变换（按匹配度排序），过滤 < 0.3 的噪声
  const scored = useMemo(
    () => (item ? applicableTransforms(ctx).filter((s) => s.score >= 0.3) : []),
    [item, ctx],
  );

  // 分区：推荐（≥0.6）vs 其他工具（0.3~0.6）
  const recommended = useMemo(() => scored.filter((s) => s.score >= 0.6), [scored]);
  const others = useMemo(() => scored.filter((s) => s.score < 0.6), [scored]);

  // P2：doc/rich 条目的 HTML 片段，注入到变换的 opts 供 run() 取用
  const itemHtml = item && (item.type === "doc" || item.type === "rich") ? item.content : undefined;

  // 打开 / 切换内容时重置选项与复制反馈
  useEffect(() => {
    const init: Record<string, Record<string, string>> = {};
    for (const { transform: t } of scored) init[t.id] = defaultOptsFromSpecs(specsFor(t, ctx));
    setOpts(init);
    setCopiedId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id]);

  const optsFor = useCallback((t: Transform) => opts[t.id] ?? defaultOptsFromSpecs(specsFor(t, ctx)), [opts, ctx]);
  const setOpt = useCallback(
    (id: string, key: string, value: string) =>
      setOpts((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), [key]: value } })),
    [],
  );

  // 复制指定卡的产物；复制后不关闭，允许连续复制多个
  const copyTransform = useCallback(async (t: Transform) => {
    if (!item) return;
    const r = await t.run(item.text || "", { ...optsFor(t), ...(itemHtml ? { html: itemHtml } : {}) });
    if (!r.ok || !r.output) {
      toast(r.message ?? "无法转换", "error");
      return;
    }
    try {
      await navigator.clipboard.writeText(r.output);
      const n = r.meta?.count;
      toast(n ? `已复制「${t.label}」（${n} 个值）` : `已复制「${t.label}」`, "success");
      setCopiedId(t.id);
      setTimeout(() => setCopiedId((cur) => (cur === t.id ? null : cur)), 1200);
    } catch {
      toast("复制失败", "error");
    }
  }, [item, optsFor, toast, itemHtml]);

  // 把指定卡的产物直接粘贴到前台窗口
  const pasteTransform = useCallback(async (t: Transform) => {
    if (!item) return;
    const r = await t.run(item.text || "", { ...optsFor(t), ...(itemHtml ? { html: itemHtml } : {}) });
    if (!r.ok || !r.output) {
      toast(r.message ?? "无法转换", "error");
      return;
    }
    const ok = await pasteText(r.output);
    if (ok) toast(`已粘贴「${t.label}」`, "success");
  }, [item, optsFor, toast, itemHtml]);

  // Esc 关闭（其余导航键交由卡片按钮 / Tab 处理）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // 常挂载，open=false 时由 AnimatePresence 驱动退场后再卸载
  return (
    <AnimatePresence>
      {open && item && (
        <motion.div {...anim.backdrop} className="dialog-backdrop" onClick={close}>
          <FocusTrap>
            <motion.div
              {...anim.panel}
              className={`dialog-box w460 ${styles.hub}`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="dialog-header">
                <span className={styles.headerIcon}><Sparkles size={16} /></span>
                <h2 className="dialog-title">变换为…</h2>
                <span className={styles.headerSub}>{scored.length} 个可用变换</span>
                <button onClick={close} className="dialog-close"
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "")}>
                  <X size={16} />
                </button>
              </div>

              <div className={styles.cards}>
                {scored.length === 0 && (
                  <div className={styles.empty}>
                    <MelodyEmpty size={64} />
                    此内容暂无可用变换
                  </div>
                )}
                {recommended.length > 0 && (
                  <>
                    <div className={styles.sectionLabel}>推荐</div>
                    {recommended.map(({ transform: t, score }) => (
                      <TransformCard
                        key={t.id}
                        t={t}
                        score={score}
                        text={item.text || ""}
                        html={itemHtml}
                        opts={optsFor(t)}
                        specs={specsFor(t, ctx)}
                        copied={copiedId === t.id}
                        onSetOpt={(k, v) => setOpt(t.id, k, v)}
                        onCopy={() => void copyTransform(t)}
                        onPaste={() => void pasteTransform(t)}
                      />
                    ))}
                  </>
                )}
                {others.length > 0 && (
                  <>
                    <div className={styles.sectionLabel}>其他工具</div>
                    {others.map(({ transform: t, score }) => (
                      <TransformCard
                        key={t.id}
                        t={t}
                        score={score}
                        text={item.text || ""}
                        html={itemHtml}
                        opts={optsFor(t)}
                        specs={specsFor(t, ctx)}
                        copied={copiedId === t.id}
                        onSetOpt={(k, v) => setOpt(t.id, k, v)}
                        onCopy={() => void copyTransform(t)}
                        onPaste={() => void pasteTransform(t)}
                      />
                    ))}
                  </>
                )}
              </div>
            </motion.div>
          </FocusTrap>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
