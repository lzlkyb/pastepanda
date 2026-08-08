/**
 * 单个变换卡片：选项 + 预览 + 复制/粘贴，自包含、互不干扰。
 * （从 TransformHubDialog 拆出——那个文件已超过项目规则 #7 的 300 行上限）
 *
 * **本地变换与云端动作的关键差异**：
 * - 本地变换挂载即执行，直接出预览（零成本）；
 * - 云端动作（`t.remote`）**绝不自动执行**。照本地那套做的话，用户只是打开
 *   一下面板，剪贴板内容就已经发到外部服务并产生了费用。必须等用户点“运行”。
 *
 * 另外：复制/粘贴直接用本卡已算出的产物，**不重跑一遍** run()——
 * 本地变换重跑是白费，云端动作重跑是多一次往返。
 */

import { useCallback, useEffect, useState } from "react";
import {
  Copy, Check, Sparkles, Database, Table, List, ClipboardPaste,
  CaseUpper, CaseLower, Eraser, Pilcrow, Quote, RemoveFormatting, Link as LinkIcon,
  Globe, Mail, Phone, Code, Minus, Hash, Palette, Folder, FileText,
  Play, ShieldAlert, Languages, PenLine,
  type LucideIcon,
} from "lucide-react";
import { AiBadge, badgeKindOf } from "@/components/AiBadge";
import type { Transform, TransformOptionSpec, TransformResultMeta } from "@/lib/transforms";
import styles from "../TransformHub.module.css";

/** 图标语义键 → lucide 组件（逻辑层保持纯净，图标在 UI 层映射） */
const ICONS: Record<string, LucideIcon> = {
  database: Database, table: Table, rows: List,
  "case-upper": CaseUpper, "case-lower": CaseLower, eraser: Eraser, pilcrow: Pilcrow,
  quote: Quote, "remove-formatting": RemoveFormatting, link: LinkIcon, globe: Globe,
  mail: Mail, phone: Phone, code: Code, minus: Minus, hash: Hash, palette: Palette,
  folder: Folder, "file-text": FileText,
  // AI 动作的图标语义键（后端 ai/actions.rs 里声明的那几个）
  languages: Languages, "pen-line": PenLine,
};

export function TIcon({ name, size = 15 }: { name?: string; size?: number }) {
  const C = (name && ICONS[name]) || Sparkles;
  return <C size={size} />;
}

type Preview =
  /** 仅云端动作：等用户点“运行”，在那之前什么都不发 */
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ok"; output: string; meta?: TransformResultMeta }
  | {
      state: "err";
      message: string;
      /** 内容看起来是密钥，后端拒发了，等用户确认 */
      needsConfirm?: boolean;
      budgetExceeded?: boolean;
    };

export function TransformCard({
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
  onCopy: (output: string, meta?: TransformResultMeta) => void;
  onPaste: (output: string) => void;
}) {
  const isRemote = !!t.remote;
  const [preview, setPreview] = useState<Preview>(
    isRemote ? { state: "idle" } : { state: "loading" }
  );

  const execute = useCallback(
    async (force: boolean) => {
      setPreview({ state: "loading" });
      const r = await t.run(text, {
        ...opts,
        ...(html ? { html } : {}),
        ...(force ? { force: true } : {}),
      });
      if (r.ok && r.output !== undefined) {
        setPreview({ state: "ok", output: r.output, meta: r.meta });
      } else {
        setPreview({
          state: "err",
          message: r.message ?? "无法转换",
          needsConfirm: r.meta?.needsConfirm === true,
          budgetExceeded: r.meta?.budgetExceeded === true,
        });
      }
    },
    [t, text, opts, html]
  );

  useEffect(() => {
    // 云端动作：不自动跑。选项/内容一变就作废旧结果回到待命令状态，
    // 避免把上一组选项的产物当成新选项的结果展示。
    if (isRemote) {
      setPreview({ state: "idle" });
      return;
    }
    let cancelled = false;
    const result = t.run(text, { ...opts, ...(html ? { html } : {}) });
    if (result instanceof Promise) {
      setPreview({ state: "loading" });
      result.then((r) => {
        if (cancelled) return;
        setPreview(
          r.ok && r.output !== undefined
            ? { state: "ok", output: r.output, meta: r.meta }
            : { state: "err", message: r.message ?? "无法转换" }
        );
      });
    } else {
      setPreview(
        result.ok && result.output !== undefined
          ? { state: "ok", output: result.output, meta: result.meta }
          : { state: "err", message: result.message ?? "无法转换" }
      );
    }
    return () => { cancelled = true; };
  }, [t, text, opts, html, isRemote]);

  const hasOutput = preview.state === "ok";

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.cardIcon}><TIcon name={t.icon} /></span>
        <span className={styles.cardMain}>
          <span className={styles.cardLabel}>
            {t.label}
            {/* 显不显示由 remote 决定（风险标记不能漏），写什么字由分组决定 */}
            {isRemote && <AiBadge kind={badgeKindOf(t)} />}
          </span>
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

      {preview.state === "idle" && (
        <pre className={styles.cardPreview}>点“运行”后才会发送到云端。</pre>
      )}
      {preview.state === "loading" && (
        <pre className={styles.cardPreview}>{isRemote ? "请求中…" : "转换中…"}</pre>
      )}
      {preview.state === "ok" && (
        <>
          <pre className={styles.cardPreview}>{preview.output}</pre>
          {isRemote && (
            <div className={styles.remoteMeta}>
              {preview.meta?.cached ? "命中缓存，本次未计费" : `模型 ${preview.meta?.model ?? "-"}`}
            </div>
          )}
          {/* 截断必须说出来：不说的话用户看到的只是一个断在半句的回答，
              会归咎于模型不行，而不是去把 token 上限调大 */}
          {preview.meta?.truncated ? (
            <div className={styles.previewWarn}>
              <ShieldAlert size={12} /> 回答被 token 上限截断了——去设置里把这个动作的上限调大再试。
            </div>
          ) : null}
        </>
      )}
      {preview.state === "err" && (
        <pre className={preview.needsConfirm ? styles.previewWarn : styles.previewErr}>
          {preview.needsConfirm && <ShieldAlert size={12} />} {preview.message}
        </pre>
      )}

      <div className={styles.cardActions}>
        {/* 云端动作：先有“运行”，跑完才能复制/粘贴 */}
        {isRemote && preview.state !== "ok" && (
          <button
            className={styles.runBtn}
            onClick={() => void execute(preview.state === "err" && !!preview.needsConfirm)}
            disabled={preview.state === "loading"}
          >
            {preview.state === "err" && preview.needsConfirm ? (
              <><ShieldAlert size={13} />仍然发送</>
            ) : (
              <><Play size={13} />运行</>
            )}
          </button>
        )}
        {isRemote && preview.state === "ok" && (
          <button className={styles.runBtn} onClick={() => void execute(false)}>
            <Play size={13} />重新运行
          </button>
        )}

        <button
          className={`${styles.copyBtn} ${copied ? styles.copyBtnDone : ""}`}
          onClick={() => hasOutput && onCopy(preview.output, preview.meta)}
          disabled={!hasOutput}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "已复制" : "复制"}
        </button>
        <button
          className={styles.pasteBtn}
          onClick={() => hasOutput && onPaste(preview.output)}
          disabled={!hasOutput}
        >
          <ClipboardPaste size={13} />
          粘贴到前台
        </button>
      </div>
    </div>
  );
}
