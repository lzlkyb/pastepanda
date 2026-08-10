/**
 * AiResult.tsx — AI 动作结果的完整操作区（M3 偏好学习）。
 *
 * 编辑（EditableResult）+ 模型/缓存提示 + 截断警告 + 复制/粘贴。
 * 复制/粘贴时回写反馈信号：改过 → edited，直接复制 → accepted。
 * **只回写动作 id + 结果哈希，不传内容明文**（红线）。
 *
 * 从 TransformCard 拆出：AI 单结果的交互（编辑/回写）不该把卡片组件撑过 300 行。
 */

import { useState } from "react";
import { Copy, Check, ClipboardPaste, ShieldAlert } from "lucide-react";
import type { Transform, TransformResultMeta } from "@/lib/transforms";
import { aiFeedbackAdd, hashResult } from "@/lib/api/aiFeedback";
import { EditableResult } from "@/components/transform/EditableResult";
import styles from "../TransformHub.module.css";

/** AI 结果元信息（cached/model/truncated 显式类型，仍兼容宽松的 TransformResultMeta） */
export interface AiResultMeta extends TransformResultMeta {
  cached?: boolean;
  model?: string;
  truncated?: boolean;
}

export function AiResult({
  t,
  output,
  meta,
  copied,
  onCopy,
  onPaste,
}: {
  t: Transform;
  output: string;
  meta?: AiResultMeta;
  copied: boolean;
  onCopy: (output: string, meta?: AiResultMeta) => void;
  onPaste: (output: string) => void;
}) {
  const [editedText, setEditedText] = useState<string | null>(null);
  const final = editedText ?? output;
  const wasEdited = editedText !== null;

  /** 回写反馈信号：只记动作 id + 结果哈希（fire-and-forget） */
  const log = (out: string) => {
    void aiFeedbackAdd({
      actionId: t.id,
      outcome: wasEdited ? "edited" : "accepted",
      resultHash: hashResult(out),
    });
  };

  return (
    <>
      <EditableResult output={output} onEdited={setEditedText} />
      {/* v6.4：模型 accent chip / 缓存绿 chip（主题变量） */}
      <div className={styles.aiMetaRow}>
        {meta?.cached ? (
          <span className={styles.chipCached}>缓存命中 · 未计费</span>
        ) : (
          <span className={styles.chipModel}>模型 {meta?.model ?? "-"}</span>
        )}
        {wasEdited && <span className={styles.editedBadge}>已修改</span>}
      </div>
      {meta?.truncated && (
        <div className={styles.previewWarn}>
          <ShieldAlert size={12} /> 回答被 token 上限截断了——去设置里把这个动作的上限调大再试。
        </div>
      )}
      <div className={styles.cardActions}>
        <button
          className={`${styles.copyBtn} ${copied ? styles.copyBtnDone : ""}`}
          onClick={() => {
            onCopy(final, meta);
            log(final);
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "已复制" : "复制"}
        </button>
        <button
          className={styles.pasteBtn}
          onClick={() => {
            onPaste(final);
            log(final);
          }}
        >
          <ClipboardPaste size={13} />
          粘贴到前台
        </button>
      </div>
    </>
  );
}
