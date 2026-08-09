/**
 * 单个变换卡片：选项 + 预览 + 复制/粘贴，自包含、互不干扰。
 * （从 TransformHubDialog 拆出——那个文件已超过项目规则 #7 的 300 行上限）
 *
 * **本地变换与云端动作的关键差异**：
 * - 本地变换挂载即执行，直接出预览（零成本）；
 * - 云端动作（`t.remote`）**绝不自动执行**。照本地那套做的话，用户只是打开
 *   一下面板，剪贴板内容就已经发到外部服务并产生了费用。必须等用户点“运行”。
 *
 * **执行类动作（`t.kind === "action"`）同理且更严格**：run() 有真实副作用
 * （打开浏览器/资源管理器），打开面板就执行等于把系统操作权交给悬停本身。
 * 所以 action 卡片只有「执行」按钮：没有预览、没有复制/粘贴。
 *
 * 另外：复制/粘贴直接用本卡已算出的产物，**不重跑一遍** run()——
 * 本地变换重跑是白费，云端动作重跑是多一次往返。
 */

import { useCallback, useEffect, useState } from "react";
import {
  Copy, Check, Sparkles, Database, Table, List, ClipboardPaste,
  CaseUpper, CaseLower, Eraser, Pilcrow, Quote, RemoveFormatting, Link as LinkIcon,
  Globe, Mail, Phone, Code, Minus, Hash, Palette, Folder, FileText,
  Play, ShieldAlert, Languages, PenLine, Search, X,
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
  folder: Folder, "file-text": FileText, search: Search,
  // AI 动作的图标语义键（后端 ai/actions.rs 里声明的那几个）
  languages: Languages, "pen-line": PenLine,
};

export function TIcon({ name, size = 15 }: { name?: string; size?: number }) {
  const C = (name && ICONS[name]) || Sparkles;
  return <C size={size} />;
}

type Preview =
  /** 云端动作/执行类动作：等用户点“运行/执行”，在那之前什么都不发 */
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ok"; output: string; meta?: TransformResultMeta }
  /** 仅执行类动作：run() 成功但无产物（副作用已完成） */
  | { state: "done" }
  | {
      state: "err";
      message: string;
      /** 内容看起来是密钥，后端拒发了，等用户确认 */
      needsConfirm?: boolean;
      budgetExceeded?: boolean;
    };

export function TransformCard({
  t, score, text, opts, html, specs, copied, onSetOpt, onCopy, onPaste, contentType, onDismiss,
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
  /** v6.1：当前内容类型，供「不再推荐这个」记录 (动作, 类型) */
  contentType?: string;
  /** v6.1：点击「不再推荐这个」后回调（父组件刷新排序） */
  onDismiss?: (actionId: string) => void;
}) {
  const isRemote = !!t.remote;
  const isAction = t.kind === "action";
  const [preview, setPreview] = useState<Preview>(
    isRemote || isAction ? { state: "idle" } : { state: "loading" }
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
      } else if (r.ok && isAction) {
        // 执行类动作：ok 但无产物 = 副作用已完成
        setPreview({ state: "done" });
      } else {
        setPreview({
          state: "err",
          message: r.message ?? "无法转换",
          needsConfirm: r.meta?.needsConfirm === true,
          budgetExceeded: r.meta?.budgetExceeded === true,
        });
      }
    },
    [t, text, opts, html, isAction]
  );

  useEffect(() => {
    // 云端动作 / 执行类动作：不自动跑。前者避免打开面板就发内容花钱，
    // 后者避免打开面板就执行副作用（打开浏览器/资源管理器）。
    if (isRemote || isAction) {
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
  }, [t, text, opts, html, isRemote, isAction]);

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
        {/* v6.1 负反馈：不再推荐这个动作（对该内容类型）。点一下从排序里消失 */}
        {onDismiss && (
          <button
            className={styles.dismissBtn}
            title="不再推荐这个"
            aria-label="不再推荐这个"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss(t.id);
            }}
          >
            <X size={11} />
          </button>
        )}
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
        <pre className={styles.cardPreview}>
          {isAction ? "点「执行」后才会打开/定位。" : "点“运行”后才会发送到云端。"}
        </pre>
      )}
      {preview.state === "loading" && (
        <pre className={styles.cardPreview}>{isRemote ? "请求中…" : isAction ? "执行中…" : "转换中…"}</pre>
      )}
      {preview.state === "done" && (
        <pre className={styles.cardPreview}>已执行 ✓</pre>
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
        {/* 执行类动作：只有「执行」，无预览/复制/粘贴 */}
        {isAction && (
          <>
            {preview.state !== "done" ? (
              <button
                className={styles.runBtn}
                onClick={() => void execute(false)}
                disabled={preview.state === "loading"}
              >
                <Play size={13} />
                {preview.state === "loading" ? "执行中…" : "执行"}
              </button>
            ) : (
              <button className={styles.runBtn} onClick={() => void execute(false)}>
                <Play size={13} />重新执行
              </button>
            )}
          </>
        )}

        {/* 云端动作：先有“运行”，跑完才能复制/粘贴 */}
        {!isAction && isRemote && preview.state !== "ok" && (
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
        {!isAction && isRemote && preview.state === "ok" && (
          <button className={styles.runBtn} onClick={() => void execute(false)}>
            <Play size={13} />重新运行
          </button>
        )}

        {/* 执行类动作没有复制/粘贴（没有产物可复制） */}
        {!isAction && (
          <>
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
          </>
        )}
      </div>
    </div>
  );
}
