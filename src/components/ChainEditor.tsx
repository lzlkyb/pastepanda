/**
 * ChainEditor.tsx — 自定义动作链编辑器（X1 B2）。
 *
 * 从变换注册表选步骤、增删排序、命名保存。只做"增删排序"，不做可视化画布
 * （X1 规划：普通用户用不到 Zapier 式画布）。
 *
 * 交互约定：
 * - 步骤只能选 `kind !== "action"` 的变换（执行类有副作用，不该进文本流水线）；
 * - risk 自动标注：remote（AI）→ network，其余 → local；destructive 仅预置链用；
 * - 保存后失效运行器的链缓存（invalidateUserChains），下次打开即见。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Plus, Trash2, ChevronUp, ChevronDown, Save } from "lucide-react";
import { useDialogStore } from "@/stores/dialogStore";
import { listTransforms } from "@/lib/transforms/registry";
import { chainSave, chainDelete } from "@/lib/api/chains";
import { invalidateUserChains } from "@/lib/chains/registry";
import type { ChainDef } from "@/lib/api/chains";
import type { ChainStep } from "@/lib/chains/types";
import { useToast } from "@/components/Toast";
import { useDialogAnim } from "@/lib/dialogMotion";
import { FocusTrap } from "@/components/FocusTrap";
import styles from "./ChainEditor.module.css";

const MAX_STEPS = 8;

const RISK_LABEL: Record<string, string> = { local: "本地", network: "联网", destructive: "修改" };

export function ChainEditor() {
  const editing = useDialogStore((s) => s.chainEdit);
  const close = useCallback(() => useDialogStore.getState().closeChainEditor(), []);
  const open = editing !== null;
  const anim = useDialogAnim();
  const { toast } = useToast();

  // 新建时 editing === null（openChainEditor(null)）→ 空草稿；编辑时拷贝草稿（不直接改 store 对象）
  const [draft, setDraft] = useState<ChainDef>({
    id: "",
    name: "",
    description: "",
    steps: [],
  });
  useEffect(() => {
    if (!open) return;
    setDraft(
      editing
        ? { ...editing, steps: editing.steps.map((s) => ({ ...s })) }
        : { id: "", name: "", description: "", steps: [] },
    );
  }, [open, editing]);

  const patch = (p: Partial<ChainDef>) => setDraft((d) => ({ ...d, ...p }));

  /** 可选的步骤变换：排除执行类（action），避免"流水线里夹一个打开浏览器" */
  const stepOptions = useMemo(
    () => listTransforms().filter((t) => t.kind !== "action"),
    // 每次打开重新计算（变换注册表可能在运行期间变化，如 AI 动作初始化）
    [open],
  );

  const setStep = (i: number, transformId: string) => {
    const t = stepOptions.find((x) => x.id === transformId);
    const step: ChainStep = {
      transformId,
      risk: t?.remote ? "network" : "local",
    };
    setDraft((d) => {
      const steps = [...d.steps];
      steps[i] = step;
      return { ...d, steps };
    });
  };

  const addStep = () => {
    if (draft.steps.length >= MAX_STEPS) {
      toast(`步骤最多 ${MAX_STEPS} 个（多了难以排错）`, "warning");
      return;
    }
    setDraft((d) => ({ ...d, steps: [...d.steps, { transformId: "", risk: "local" }] }));
  };

  const move = (i: number, dir: -1 | 1) => {
    setDraft((d) => {
      const steps = [...d.steps];
      const j = i + dir;
      if (j < 0 || j >= steps.length) return d;
      [steps[i], steps[j]] = [steps[j], steps[i]];
      return { ...d, steps };
    });
  };

  const removeStep = (i: number) =>
    setDraft((d) => ({ ...d, steps: d.steps.filter((_, idx) => idx !== i) }));

  const save = async () => {
    if (!draft.name.trim()) {
      toast("给这条链起个名字", "warning");
      return;
    }
    if (draft.steps.length === 0) {
      toast("至少要有 1 个步骤", "warning");
      return;
    }
    if (draft.steps.some((s) => !s.transformId)) {
      toast("还有步骤没选变换", "warning");
      return;
    }
    try {
      await chainSave(draft);
      invalidateUserChains();
      toast(`已保存「${draft.name.trim()}」`, "success");
      close();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const remove = async () => {
    if (!draft.id) return;
    try {
      await chainDelete(draft.id);
      invalidateUserChains();
      toast(`已删除「${draft.name}」`, "success");
      close();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div {...anim.backdrop} className="dialog-backdrop" onClick={close}>
          <FocusTrap>
            <motion.div
              {...anim.panel}
              className={`dialog-box w460 ${styles.wrap}`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="dialog-header">
                <span className={styles.headerIcon}><Plus size={15} /></span>
                <h2 className="dialog-title">{draft.id ? "编辑动作链" : "新建动作链"}</h2>
                <span className={styles.headerSub}>步骤按顺序执行，上一步输出喂给下一步</span>
                <button onClick={close} className="dialog-close" aria-label="关闭">
                  <X size={16} />
                </button>
              </div>

              <div className={styles.field}>
                <label className={styles.label}>名称</label>
                <input
                  className={styles.input}
                  value={draft.name}
                  maxLength={24}
                  placeholder="如：报错处理流水线"
                  onChange={(e) => patch({ name: e.target.value })}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>描述（可选）</label>
                <input
                  className={styles.input}
                  value={draft.description}
                  maxLength={60}
                  placeholder="这条链是做什么的"
                  onChange={(e) => patch({ description: e.target.value })}
                />
              </div>

              <div className={styles.steps}>
                {draft.steps.length === 0 && (
                  <div className={styles.empty}>还没有步骤——点下方「添加步骤」开始。</div>
                )}
                {draft.steps.map((s, i) => (
                  <div key={i} className={styles.step}>
                    <span className={styles.stepIdx}>{i + 1}</span>
                    <select
                      className={styles.select}
                      value={s.transformId}
                      onChange={(e) => setStep(i, e.target.value)}
                    >
                      <option value="">选择变换…</option>
                      {stepOptions.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label}
                          {t.remote ? "（AI）" : ""}
                        </option>
                      ))}
                    </select>
                    <span className={s.risk === "network" ? styles.riskNet : styles.riskLocal}>
                      {RISK_LABEL[s.risk] ?? s.risk}
                    </span>
                    <span className={styles.stepBtns}>
                      <button className={styles.iconBtn} onClick={() => move(i, -1)} disabled={i === 0} title="上移">
                        <ChevronUp size={13} />
                      </button>
                      <button className={styles.iconBtn} onClick={() => move(i, 1)} disabled={i === draft.steps.length - 1} title="下移">
                        <ChevronDown size={13} />
                      </button>
                      <button className={`${styles.iconBtn} ${styles.dangerBtn}`} onClick={() => removeStep(i)} title="删除此步">
                        <Trash2 size={13} />
                      </button>
                    </span>
                    {!s.transformId && (
                      <span className={styles.stepHint}>从下拉里选一个变换</span>
                    )}
                  </div>
                ))}
              </div>

              <button className={styles.addBtn} onClick={addStep}>
                <Plus size={13} /> 添加步骤（{draft.steps.length}/{MAX_STEPS}）
              </button>

              <div className={styles.actions}>
                {draft.id ? (
                  <button className={styles.deleteBtn} onClick={() => void remove()}>
                    <Trash2 size={13} /> 删除这条链
                  </button>
                ) : (
                  <span />
                )}
                <button className={styles.saveBtn} onClick={() => void save()}>
                  <Save size={13} /> 保存
                </button>
              </div>
            </motion.div>
          </FocusTrap>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
