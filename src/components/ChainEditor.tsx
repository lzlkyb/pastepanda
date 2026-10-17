import { motion } from "framer-motion";
import { ArrowLeft, Loader2, Plus, Save, Trash2, X } from "lucide-react";
import { useChainEditor, MAX_CHAIN_NAME_CHARS, MAX_CHAIN_STEPS } from "@/hooks/useChainEditor";
import type { ChainStepConditionType } from "@/lib/chains/types";
import { useDialogEscape } from "@/hooks/useDialogEscape";
import { useDialogAnim } from "@/lib/dialogMotion";
import { FocusTrap } from "./FocusTrap";
import shared from "./ChainRunnerDialog.module.css";
import styles from "./ChainEditor.module.css";

export { MAX_CHAIN_NAME_CHARS } from "@/hooks/useChainEditor";

export function ChainEditor() {
  const e = useChainEditor();
  const anim = useDialogAnim();
  useDialogEscape(e.close, e.open);
  const ready = !!e.draft.name.trim() && e.draft.steps.length > 0 && e.draft.steps.every(s => e.options.some(t => t.id === s.transformId));
  return e.open ? <motion.div {...anim.backdrop} className="dialog-backdrop" onClick={e.close}>
    <FocusTrap ariaLabel="编辑处理步骤">
      <motion.div {...anim.panel} className={`dialog-box w460 ${shared.wrap}`} onClick={event => event.stopPropagation()}>
        <header className={shared.header}>
          <button className={shared.back} onClick={e.close} disabled={e.saving}><ArrowLeft size={15} />返回</button>
          <div><h2>{e.draft.id ? "调整处理步骤" : "组合处理步骤"}</h2><p>上一步的结果，作为下一步输入</p></div>
          <button className="dialog-close" onClick={e.close} disabled={e.saving} aria-label="关闭步骤编辑"><X size={16} /></button>
        </header>
        <div className={shared.body}>
          <label className={shared.label}>流程名称 <span className={shared.hint}>{Array.from(e.draft.name).length}/{MAX_CHAIN_NAME_CHARS}</span>
            <input className={shared.input} value={e.draft.name} maxLength={MAX_CHAIN_NAME_CHARS} disabled={e.saving} placeholder="如：网页清理后提炼要点" onChange={event => e.patch({ name: event.target.value })} />
          </label>
          <details className={shared.advanced}><summary>用途说明（可选）</summary><input className={shared.input} aria-label="用途说明" value={e.draft.description} maxLength={60} disabled={e.saving} onChange={event => e.patch({ description: event.target.value })} /></details>
          {!e.draft.steps.length && <p className={shared.hint}>先添加一个处理步骤，不需要一次想完整，可以随时调整顺序。</p>}
          {e.draft.steps.map((s, i) => {
            const available = e.options.some(t => t.id === s.transformId);
            return <div className={styles.step} key={i}>
              <div className={styles.operation}><span className={shared.number}>{i + 1}</span>
                <select aria-label={`第 ${i + 1} 步操作`} value={s.transformId} disabled={e.saving} onChange={event => e.setStep(i, event.target.value)}>
                  <option value="">选择一个处理操作…</option>
                  {!available && s.transformId && <option value={s.transformId}>已不可用，请重新选择</option>}
                  {e.options.map(t => <option key={t.id} value={t.id}>{t.label}{t.remote ? "（AI）" : ""}</option>)}
                </select>
              </div>
              {!available && s.transformId && <p className={shared.error}>这一步已不可用，请选择其他操作。原配置仍保留在草稿中。</p>}
              <div className={styles.controls}>
                <button disabled={e.saving || i === 0} onClick={() => e.move(i, -1)}>上移</button>
                <button disabled={e.saving || i === e.draft.steps.length - 1} onClick={() => e.move(i, 1)}>下移</button>
                <button className={styles.delete} disabled={e.saving} onClick={() => e.removeStep(i)}>删除此步骤</button>
              </div>
              <details className={styles.condition}><summary>执行条件 · {s.condition && s.condition.type !== "always" ? "满足条件才执行" : "每次执行"}</summary>
                <select aria-label={`第 ${i + 1} 步执行条件`} disabled={e.saving} value={s.condition?.type ?? "always"} onChange={event => e.setCondition(i, event.target.value as ChainStepConditionType)}>
                  <option value="always">每次执行</option><option value="is-json">内容是 JSON 时执行</option><option value="contains-secret">发现敏感信息时执行</option><option value="is-code">内容是代码时执行</option>
                </select><p className={shared.hint}>不满足条件时跳过这一步，原样传给下一步。</p>
              </details>
            </div>;
          })}
          <button className={shared.textButton} onClick={e.add} disabled={e.saving || e.draft.steps.length >= MAX_CHAIN_STEPS}><Plus size={13} />添加步骤（{e.draft.steps.length}/{MAX_CHAIN_STEPS}）</button>
          {e.error && <p className={shared.error} role="alert">{e.error}</p>}
          {e.draft.id && <button className={styles.deleteChain} onClick={() => void e.remove()} disabled={e.saving}><Trash2 size={13} />删除整个流程</button>}
        </div>
        <footer className={shared.footer}><div className={shared.actions}>
          <button className={shared.secondary} disabled={e.saving} onClick={e.discard}>放弃本次调整</button>
          <button className={shared.primary} disabled={e.saving || !ready} onClick={() => void e.save()}>{e.saving ? <Loader2 size={13} className="spin" /> : <Save size={13} />}{e.saving ? "正在保存…" : "保存并查看流程"}</button>
        </div><p>{!ready ? "请填写名称，并为每个步骤选择可用操作。" : "保存不会执行步骤；返回会保留本次草稿。"}</p></footer>
      </motion.div>
    </FocusTrap>
  </motion.div> : null;
}
