import type { useChainWorkspace } from "@/hooks/useChainWorkspace";
import styles from "../ChainRunnerDialog.module.css";

export function ChainPlanForm({ workspace: w }: { workspace: ReturnType<typeof useChainWorkspace> }) {
  const p = w.planner;
  return <>
    <h3>{p.loading ? "正在设计处理步骤" : "告诉 AI，你想怎样处理文字"}</h3>
    <p className={styles.intro}>AI 只设计步骤。你确认步骤后，再点运行。</p>
    <label className={styles.label}>希望得到什么结果？
      <textarea className={styles.input} value={p.goal} onChange={e => p.setGoal(e.target.value)} maxLength={500} rows={3}
        disabled={p.loading} placeholder="例如：先隐藏敏感信息，再提炼成便于分享的要点。" />
    </label>
    <div className={styles.examples}>
      <button disabled={p.loading} onClick={() => p.setGoal("先隐藏敏感信息，再提炼要点")}>先脱敏，再提炼要点</button>
      <button disabled={p.loading} onClick={() => p.setGoal("去掉网页格式，只保留干净的正文")}>网页变干净正文</button>
    </div>
    {p.sessionText && <details className={styles.advanced}><summary>更多输入</summary><label className={styles.checkLabel}>
      <input type="checkbox" checked={p.includeSession} disabled={p.loading} onChange={e => p.setIncludeSession(e.target.checked)} />附加本次连续复制的内容
    </label><p className={styles.hint}>默认只使用当前文字。附加内容也会交给所选 AI 服务。</p></details>}
    <details className={styles.advanced}><summary>核对将发送给 AI 的文字（最多前 1500 字）</summary>
      <pre className={styles.output}>{p.sample}</pre><p className={styles.hint}>上方目标也会发送。使用已配置的服务与模型，可能消耗用量。</p>
    </details>
    {p.needsConfirm && <div className={styles.warning} role="alert">{p.needsConfirm}<p>请核对上方文字；确认后将发送目标及这些内容。</p>
      <button className={styles.secondary} onClick={() => void p.generate(true)}>确认并发送以生成步骤</button></div>}
    {p.error && <p className={styles.error} role="alert">{p.error}</p>}
    {p.notice && <p className={styles.hint} role="status">{p.notice}</p>}
    {p.loading && <p className={styles.hint} role="status">正在等待 AI 返回。停止等待不能撤回已发出的内容，也不保证免除已产生的用量。</p>}
  </>;
}
