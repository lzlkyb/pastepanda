import { CheckCircle2, Info, ShieldAlert, Square } from "lucide-react";
import type { useChainWorkspace } from "@/hooks/useChainWorkspace";
import { ChainSteps } from "./ChainSteps";
import styles from "../ChainRunnerDialog.module.css";

export function ChainResult({ workspace: w }: { workspace: ReturnType<typeof useChainWorkspace> }) {
  const r = w.run.result;
  if (!r || !w.selected) return null;
  const same = r.final === w.input;
  const skipped = r.ok && r.stages.length > 0 && r.stages.every(s => s.skipped);
  const completed = r.stages.filter(s => s.ok && !s.skipped).length;
  return <>
    <h3 className={styles.resultTitle}>{r.cancelled ? <Square size={16} /> : r.ok ? <CheckCircle2 size={16} /> : <ShieldAlert size={16} />}
      {r.cancelled ? "已停止后续步骤" : !r.ok ? `第 ${(r.failedAt ?? 0) + 1} 步未完成` : skipped ? "条件不满足，步骤已跳过" : same ? "已完成，内容没有变化" : "处理完成"}
    </h3>
    <p className={styles.intro}>{!r.ok ? `已完成 ${completed} 步，后续步骤未执行。` : same ? "没有需要改变的内容，可直接使用原文或换个流程。" : "请先核对结果，再复制或粘贴。"}</p>
    {!r.ok && !r.cancelled && <p className={styles.error} role="alert">{r.stages.find(s => !s.ok)?.error || "这一步没有完成，请调整后重跑。"}</p>}
    {w.run.stopping && <p className={styles.warning} role="status">正在停止后续步骤，等待当前请求结束。已经发出的内容无法撤回，用量仍可能计入。</p>}
    <div className={styles.sectionLabel}>{r.ok ? "处理后的文字" : completed ? "已完成部分（不是最终结果）" : "原始内容（尚无步骤完成）"}</div>
    <pre className={styles.output}>{r.final || "（结果为空）"}</pre>
    {!r.cancelled && r.ok && w.selected.steps.some(s => s.transformId === "mask-sensitive") &&
      <p className={styles.hint}><Info size={12} /> 已执行敏感字段替换，请核对后再分享。</p>}
    <details className={styles.advanced} open={!r.ok && !r.cancelled}>
      <summary>查看 {w.selected.steps.length} 步处理过程</summary><ChainSteps chain={w.selected} result={r} />
    </details>
    <button className={styles.textButton} disabled={w.run.running} onClick={() => w.edit()}>保存或调整这个流程</button>
  </>;
}
