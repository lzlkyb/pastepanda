/**
 * 今日用量卡片。
 *
 * **主角是“还能做多少次”而不是金额**：不接触 API 计价的人对“还剩 ¥2.4”
 * 没有直觉，对“大约还能翻译 300 次”才有。次数由后端按用户自己的历史均值算。
 *
 * token 原始数也一并摆出来：金额是估算的，token 不是，想对账只能看它。
 */

import type { AiUsage } from "@/lib/api";
import styles from "../AiTab.module.css";

interface Props {
  usage: AiUsage | null;
  /** 免密钥厂商（Ollama / 内置免费）：不按金额计费，所以展示 token 而不是 ¥ */
  isLocal: boolean;
  /** 内容确实不出本机（只有 Ollama）。内置免费同样免密钥、同样不按金额计费，
   *  但它是远程服务、内容要出网——这两件事必须分开判，否则就会对着远程服务
   *  承诺「内容不出这台电脑」。判据定义见 useAiSettings。 */
  contentStaysLocal: boolean;
}

export function AiUsageCard({ usage, isLocal, contentStaysLocal }: Props) {
  if (!usage) return null;

  if (isLocal) {
    return (
      <div className={styles.usageCard}>
        <div className={styles.usage}>
          <span>
            今日调用 <span className={styles.usageNum}>{usage.calls}</span> 次
          </span>
          <span>
            token{" "}
            <span className={styles.usageNum}>
              {usage.promptTokens}+{usage.completionTokens}
            </span>
          </span>
          <span className={styles.usageNote}>
            {contentStaysLocal
              ? "本地模型，零费用，内容不出这台电脑。"
              : "内置免费额度，按 token 计量；内容会发送到该服务商。"}
          </span>
        </div>
      </div>
    );
  }

  const capped = usage.budgetCny > 0;
  const pct = capped ? Math.min(100, (usage.costCny / usage.budgetCny) * 100) : 0;

  return (
    <div className={styles.usageCard}>
      <div className={styles.usageRingWrap}>
        <div
          className={styles.usageRing}
          style={{ background: `conic-gradient(var(--accent) 0 ${pct}%, var(--section-bg) ${pct}% 100%)` }}
        >
          <span className={styles.usageRingInner}>{capped ? `${Math.round(pct)}%` : "∞"}</span>
        </div>
        <div className={styles.usageMeta}>
          <span className={styles.usageTitle}>
            今日用量 · 已用 ¥{usage.costCny.toFixed(2)}
            {capped && <> / ¥{usage.budgetCny.toFixed(2)}</>}
          </span>
          <div className={styles.usageBar}>
            <div
              className={pct >= 100 ? styles.usageBarFull : styles.usageBarFill}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className={styles.usageNote}>
            {usage.remainingCalls === null
              ? "未设上限。金额为估算值，真实账单以服务商为准。"
              : `预算内大约还能再做 ${usage.remainingCalls} 次。金额为估算值，真实账单以服务商为准。`}
          </span>
        </div>
      </div>
    </div>
  );
}
