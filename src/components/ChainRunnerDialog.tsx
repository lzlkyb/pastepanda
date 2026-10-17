import { motion } from "framer-motion";
import { ArrowLeft, Loader2, Sparkles, Workflow, X } from "lucide-react";
import { useChainWorkspace } from "@/hooks/useChainWorkspace";
import { useDialogEscape } from "@/hooks/useDialogEscape";
import { useDialogAnim } from "@/lib/dialogMotion";
import { chainHasAiSteps } from "@/lib/chains/registry";
import { FocusTrap } from "./FocusTrap";
import { ChainInput } from "./chains/ChainInput";
import { ChainChoices } from "./chains/ChainChoices";
import { ChainPlanForm } from "./chains/ChainPlanForm";
import { ChainSteps } from "./chains/ChainSteps";
import { ChainResult } from "./chains/ChainResult";
import { ChainFooter } from "./chains/ChainFooter";
import styles from "./ChainRunnerDialog.module.css";

export function ChainRunnerDialog() {
  const w = useChainWorkspace();
  const anim = useDialogAnim();
  useDialogEscape(w.back, w.open && !w.editing);
  const busy = w.run.running || w.planner.loading;
  let inputIssue = !w.input.trim() ? "请先展开当前内容，填写要处理的文字。" : "";
  const first = w.selected?.steps[0];
  if (!inputIssue && first?.transformId === "json_format" && (!first.condition || first.condition.type === "always")) {
    try { JSON.parse(w.input); } catch { inputIssue = "当前文字不是有效 JSON，请修改输入或换一个流程。"; }
  }
  return w.open ? <motion.div {...anim.backdrop}
    className={`dialog-backdrop ${w.editing ? styles.suspended : ""}`} aria-hidden={w.editing || undefined} onClick={w.close}>
    <FocusTrap active={!w.editing} ariaLabel="多步处理">
      <motion.div {...anim.panel} className={`dialog-box w460 ${styles.wrap}`} onClick={e => e.stopPropagation()}>
        <header className={styles.header}>
          <button className={styles.back} onClick={w.back} aria-label="返回上一级"><ArrowLeft size={15} />返回</button>
          <div><h2>多步处理</h2><p>同一段文字，按顺序完成多个操作</p></div>
          <button className="dialog-close" onClick={w.close} aria-label="关闭多步处理"><X size={16} /></button>
        </header>
        {!w.run.running && !w.run.result && <div className={styles.tabs} role="tablist" aria-label="选择流程来源">
          <button role="tab" aria-selected={w.view !== "ai"} disabled={busy} onClick={() => w.switchView("choose")}><Workflow size={14} />用现成流程</button>
          {w.aiAvailable && <button role="tab" aria-selected={w.view === "ai"} disabled={busy} onClick={() => w.switchView("ai")}><Sparkles size={14} />让 AI 设计流程</button>}
        </div>}
        <div className={styles.body}>
          {!w.run.running && !w.run.result && w.view !== "ai" && <ChainInput value={w.input} onChange={w.setInput} />}
          {w.run.result ? <ChainResult workspace={w} /> : w.run.pending ? <>
            <h3>第 {w.run.pending.index + 1} 步需要发送给 AI</h3><p className={styles.intro}>{w.run.pending.label} · 使用已配置的服务与模型</p>
            <p className={styles.warning}>确认后才会发送以下内容，可能消耗用量；后续 AI 步骤仍会分别确认。</p>
            <pre className={styles.output}>{w.run.pending.input}</pre>
          </> : w.run.running && w.selected ? <>
            <h3 role="status"><Loader2 size={15} className="spin" /> 正在处理第 {(w.run.progress?.index ?? 0) + 1} / {w.selected.steps.length} 步</h3>
            <p className={styles.intro}>{w.selected.name}</p><ChainSteps chain={w.selected} progress={w.run.progress} />
          </> : w.view === "ai" ? <>
            <ChainPlanForm workspace={w} /><ChainInput value={w.input} onChange={w.setInput} disabled={w.planner.loading} />
          </> : w.view === "choose" ? <ChainChoices workspace={w} /> : w.selected ? <>
            <div className={styles.sectionLabel}><strong>{w.selected.name}</strong><button className={styles.textButton} onClick={() => w.switchView("choose")}>换一个流程</button></div>
            <p className={styles.intro}>{w.selected.description}</p>
            {w.warnings.map(note => <p className={styles.warning} key={note}>{note}</p>)}
            <div className={styles.sectionLabel}>将依次执行 {w.selected.steps.length} 步 <span className={styles.tag}>{chainHasAiSteps(w.selected) ? "含 AI 处理" : "全部本地"}</span></div>
            <ChainSteps chain={w.selected} />
            {w.selected.corrupted && <p className={styles.error}>这份流程的步骤配置已损坏，请重新配置。</p>}
            {inputIssue && <p className={styles.error} role="alert">{inputIssue}</p>}
            {w.selected.id === "web-to-text" && !/<[^>]+>/.test(w.input) && <p className={styles.warning}>当前文字没有网页标签，这个流程可能不会改变内容。可以换流程，或仍然运行查看结果。</p>}
            {chainHasAiSteps(w.selected) && <p className={styles.hint}>AI 步骤会在发送前展示内容并等待确认。</p>}
          </> : <p className={styles.error}>流程不存在或正在加载，请返回重新选择。</p>}
          {w.run.error && <p className={styles.error} role="alert">没有运行成功：{w.run.error}</p>}
        </div>
        <ChainFooter workspace={w} inputIssue={inputIssue} />
      </motion.div>
    </FocusTrap>
  </motion.div> : null;
}
