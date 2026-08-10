/**
 * 回复草稿的多候选展示块：每个候选一个卡片（标题 + 预览 + 复制/粘贴），
 * 从 TransformCard 拆出——候选列表本身不该把卡片组件撑过 300 行。
 *
 * 交互约定与卡片一致：复制不重跑 run()，直接用已算出的产物。
 */

import { useState } from "react";
import { Check, Copy, ClipboardPaste } from "lucide-react";
import type { ReplyCandidate } from "@/lib/replyCandidates";
import styles from "./ReplyCandidates.module.css";

export function ReplyCandidates({
  candidates,
  onCopy,
  onPaste,
}: {
  candidates: ReplyCandidate[];
  onCopy: (text: string) => void;
  onPaste: (text: string) => void;
}) {
  // 局部"已复制"状态：只标记刚复制的那一个，2 秒后回落
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const handleCopy = (i: number, text: string) => {
    onCopy(text);
    setCopiedIdx(i);
    window.setTimeout(() => setCopiedIdx((cur) => (cur === i ? null : cur)), 2000);
  };

  return (
    <div className={styles.list}>
      {candidates.map((c, i) => (
        <div key={i} className={styles.block}>
          {c.title && <div className={styles.title}>{c.title}</div>}
          <pre className={styles.preview}>{c.text}</pre>
          <div className={styles.actions}>
            <button
              className={copiedIdx === i ? styles.copyDone : styles.copy}
              onClick={() => handleCopy(i, c.text)}
            >
              {copiedIdx === i ? <Check size={13} /> : <Copy size={13} />}
              {copiedIdx === i ? "已复制" : "复制"}
            </button>
            <button className={styles.paste} onClick={() => onPaste(c.text)}>
              <ClipboardPaste size={13} />
              粘贴到前台
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
