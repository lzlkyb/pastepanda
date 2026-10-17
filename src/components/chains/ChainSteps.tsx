import { Check, Loader2 } from "lucide-react";
import { getTransform } from "@/lib/transforms/registry";
import type { Chain, ChainRunProgress, ChainRunResult } from "@/lib/chains/types";
import styles from "../ChainRunnerDialog.module.css";

export function ChainSteps({ chain, progress, result }: { chain: Chain; progress?: ChainRunProgress | null; result?: ChainRunResult | null }) {
  const stages = result?.stages ?? progress?.stages ?? [];
  return <ol className={styles.steps}>
    {chain.steps.map((step, i) => {
      const t = getTransform(step.transformId);
      const stage = stages.find(s => s.stepIndex === i);
      const active = !result && progress?.index === i && progress.state !== "finished";
      return <li key={i} className={styles.step}>
        <span className={`${styles.number} ${stage?.ok ? styles.stepDone : ""}`}>
          {stage?.ok ? <Check size={13} /> : active ? <Loader2 size={13} className="spin" /> : i + 1}
        </span>
        <div className={styles.stepMain}><strong>{step.label ?? t?.label ?? step.transformId}</strong>
          <small>{t?.description || (!t ? "这一步已不可用，请重新选择" : "按顺序处理上一步的结果")}</small>
          {step.condition && step.condition.type !== "always" && <small>仅在{step.condition.type === "is-json" ? "内容是 JSON" : step.condition.type === "is-code" ? "内容是代码" : "发现敏感信息"}时执行，否则跳过</small>}
          {stage && <details className={styles.stepDetails}><summary>查看输入与输出</summary>
            <p>输入</p><pre>{stage.input || "（空内容）"}</pre><p>输出</p><pre>{stage.ok ? stage.output || "（空内容）" : stage.error}</pre>
          </details>}
        </div>
        <span className={stage && !stage.ok ? styles.errorText : styles.tag}>
          {stage ? stage.skipped ? "已跳过" : stage.ok ? "已完成" : "失败" : active ? progress?.state === "confirming" ? "等待确认" : "正在处理" : result ? "未执行" : t?.remote ? "AI 处理" : "本地"}
        </span>
      </li>;
    })}
  </ol>;
}
