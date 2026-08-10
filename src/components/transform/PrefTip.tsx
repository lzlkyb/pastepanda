/**
 * PrefTip.tsx —— 偏好自荐的轻提示（A：反馈 → 偏好）。
 *
 * ## 为什么在结果区下方，而不是主窗口的 SuggestionBar
 *
 * 用户**刚改完**就在这里问，上下文最相关。放到 SuggestionBar 就变成
 * “下次复制东西时突然弹一下”——那时候用户已经在干另一件事，
 * 而一条关于“上次那个译文”的建议就只剩打断价值。
 *
 * ## 三个出口为何不算重复
 *
 * 「记住」写入偏好；「不用」与 ✕ 语义完全相同（都是 `pref_signal_dismiss`）。
 * 保留 ✕ 是给“我现在不想读这个”一个**零阅读成本**的出口——主动建议的第一条约束
 * 是“一眼可否决”，而让人先读完两个按钮才能关掉就不叫一眼。
 *
 * ## 否决的粒度
 *
 * 否决的是**这一条 (动作, 特征)**，不是整个动作。你拒绝了“输出再精简”，
 * 下回你总删 Markdown 标记时它仍会问——因为那是另一件事。
 */

import { useState } from "react";
import { Sparkles, X } from "lucide-react";
import {
  prefSignalAccept,
  prefSignalDismiss,
  type PrefSignalTop,
} from "@/lib/api/aiFeedback";
import {
  PREF_OBSERVATION,
  PREF_SENTENCE,
  type PrefFeature,
} from "@/lib/prefLearn";
import { useToast } from "@/components/Toast";
import styles from "./PrefTip.module.css";

export function PrefTip({
  signal,
  onDone,
}: {
  signal: PrefSignalTop;
  /** 接受或否决后收起（父级把状态置 null） */
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  // 后端的 feature 是字符串，这里收紧到联合类型再查表。
  // 查不到就不渲染：宁可什么都不显示，也不能在界面上渲出 undefined。
  const feature = signal.feature as PrefFeature;
  const observation = PREF_OBSERVATION[feature];
  const sentence = PREF_SENTENCE[feature];
  if (!observation || !sentence) return null;

  const accept = async () => {
    setBusy(true);
    try {
      await prefSignalAccept(signal.actionId, signal.feature, sentence);
      toast(`已记住：${sentence}`, "success");
      onDone();
    } catch (e) {
      toast(`没存上：${e}`, "error");
      setBusy(false);
    }
  };

  const dismiss = async () => {
    setBusy(true);
    try {
      await prefSignalDismiss(signal.actionId, signal.feature);
    } catch {
      // 否决没记上不值得报错——用户要的是“它消失”，而那一定会发生
    }
    onDone();
  };

  return (
    <div className={styles.tip}>
      <Sparkles size={14} className={styles.ico} />
      <div className={styles.body}>
        <div>
          <span className={styles.obs}>{observation}</span>
          <span className={styles.count}>（这是第 {signal.count} 次）</span>
        </div>
        <div>
          要不要让我以后都记住：
          <span className={styles.sentence}>{sentence}</span>
        </div>
        <div className={styles.acts}>
          <button
            className={`${styles.btn} ${styles.primary}`}
            onClick={accept}
            disabled={busy}
          >
            记住
          </button>
          <button className={styles.btn} onClick={dismiss} disabled={busy}>
            不用
          </button>
        </div>
      </div>
      <button
        className={styles.close}
        onClick={dismiss}
        disabled={busy}
        title="不用，且不要再问"
        aria-label="不用，且不要再问"
      >
        <X size={13} />
      </button>
    </div>
  );
}
