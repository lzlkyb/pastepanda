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
import {
  aiFeedbackAdd,
  hashResult,
  prefSignalAdd,
  prefSignalTop,
  type PrefSignalTop,
} from "@/lib/api/aiFeedback";
import { extractPrefFeatures } from "@/lib/prefLearn";
import { EditableResult } from "@/components/transform/EditableResult";
import { PrefTip } from "@/components/transform/PrefTip";
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
  /** 攒够同方向信号后的待确认偏好建议（未达阈值 / 已处理 → null） */
  const [prefSignal, setPrefSignal] = useState<PrefSignalTop | null>(null);

  /**
   * 回写反馈信号：只记动作 id + 结果哈希（fire-and-forget）。
   *
   * 改过的话额外算一次**偏好方向**：哈希只能告诉后端“被改过”，反推不出风格——
   * 没有方向，系统就只能提醒用户去手动写偏好，它自己学不到东西。
   * `extractPrefFeatures` 在**本地**比对，上报的只有枚举标签（如 `shorter`），
   * 原文与改动一个字都不出这个函数（后端还会再校一次白名单）。
   */
  const log = (out: string) => {
    void aiFeedbackAdd({
      actionId: t.id,
      outcome: wasEdited ? "edited" : "accepted",
      resultHash: hashResult(out),
    });
    if (wasEdited) {
      const features = extractPrefFeatures(output, out);
      if (features.length === 0) return;
      // 先记这一笔，再问“够不够提议了”——顺序不能倒，否则第 3 次改完拿到的
      // 还是 2 次的计数，建议要拖到第 4 次才出现。
      // 查不到（未达阈值或已被否决）就安静保持 null，不打扰。
      void prefSignalAdd(t.id, features)
        .then(() => prefSignalTop(t.id))
        .then(setPrefSignal)
        .catch(() => {
          // 记账与查询失败都不影响用户拿到产物，静默即可
        });
    }
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
      {prefSignal && (
        <PrefTip signal={prefSignal} onDone={() => setPrefSignal(null)} />
      )}
    </>
  );
}
