/**
 * ChainEditor.tsx — 自定义动作链编辑器（X1 B2）。
 *
 * 从变换注册表选步骤、增删排序、命名保存。只做"增删排序"，不做可视化画布
 * （X1 规划：普通用户用不到 Zapier 式画布）。
 *
 * 交互约定：
 * - 步骤只能选 `kind !== "action"` 的变换（执行类有副作用，不该进文本流水线）；
 * - risk 自动标注：remote（AI）→ network，其余 → local；destructive 仅预置链用；
 * - 保存前校验步骤引用的变换**仍存在于注册表**——这是前后端分层约定（见
 *   data_store/chains.rs 顶部注释：后端不认识前端注册表），不校就两侧都没人管；
 * - 保存后失效运行器的链缓存（invalidateUserChains），下次打开即见。
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Plus, Trash2, ChevronUp, ChevronDown, Save } from "lucide-react";
import { useDialogStore } from "@/stores/dialogStore";
import { listTransforms, getTransform } from "@/lib/transforms/registry";
import { chainSave, chainDelete } from "@/lib/api/chains";
import { confirmDialog } from "@/lib/confirm";
import { invalidateUserChains, riskOf } from "@/lib/chains/registry";
import type { ChainDef } from "@/lib/api/chains";
import type { ChainStep } from "@/lib/chains/types";
import { useToast } from "@/components/Toast";
import { useDialogAnim } from "@/lib/dialogMotion";
import { FocusTrap } from "@/components/FocusTrap";
import styles from "./ChainEditor.module.css";

const MAX_STEPS = 8;

/**
 * 链名长度上限（字符）。**必须与后端 data_store/chains.rs 的 MAX_CHAIN_NAME_CHARS 一致**
 * ——超了 chain_save 直接报错；后端按 `chars().count()` 数（中文算 1 个）。
 * 没有从 Rust 生成的共享常量，所以在这里手写并**导出**给其它造链入口复用
 * （如 SequenceDiscover 算自动链名的截断长度），避免第二处手写 24 各自漂。
 */
export const MAX_CHAIN_NAME_CHARS = 24;

const RISK_LABEL: Record<string, string> = { local: "本地", network: "联网", destructive: "修改" };

/** v6.10：执行条件的白话说明（设计稿：非「无条件」时在步骤下解释跳过语义） */
const COND_HINT: Record<string, string> = {
  "is-json": "是 JSON 时——不是 JSON 会自动跳过这步",
  "contains-secret": "含敏感时——不含敏感会自动跳过这步",
  "is-code": "是代码时——不是代码会自动跳过这步",
};

/**
 * 步骤引用了下拉里没有的变换时的兜底显示。受控 select 的 value 不在 options 里
 * 会渲染成空白，而 transformId 非空又让原有 stepHint 不显示——用户既看不出这步
 * 原来是什么，也没被告知有问题，点保存就把悬空 id 又存一遍。
 */
function danglingLabel(id: string): string {
  const t = getTransform(id);
  // 能查到 = 注册了但不可选（执行类）；查不到 = 已被注销（删掉/停用的自定义 AI 动作）
  return t ? `${t.label}（不可用于链）` : `${id}（已失效）`;
}

export function ChainEditor() {
  const editing = useDialogStore((s) => s.chainEdit);
  const close = useCallback(() => useDialogStore.getState().closeChainEditor(), []);
  const open = editing !== null;
  // 审查：Esc 关闭（全局 Esc 对部分场景让位，组件自兜底）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // 同 ProfileDialog：必须是 close 而不是 close()。依赖数组在渲染期构造，
    // 写成调用会让每次渲染都执行一次关闭动作，弹窗永远打不开。
  }, [open, close]);

  const anim = useDialogAnim();
  const { toast } = useToast();

  // 新建时 editing 是空链对象（dialogStore.openChainEditor 收口：null → 空对象，
  // 直接存 null 会因 `editing !== null` 判断打不开——历史 bug）；编辑时拷贝草稿（不直接改 store 对象）
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
    // `[open]` 是故意的，**不能**按 eslint 建议改成 `[]`：listTransforms() 不纯
    // （模块级 Map，initAiTransforms / reloadAiCustomActions 在启动后、用户每次改 AI
    // 自定义动作时都会增删它），而本组件常挂载（CardList 无条件渲染）。改 `[]`
    // 会把下拉快照冻在首次挂载那一刻：启动后才配好 AI 的用户一辈子看不到 AI 步骤。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open],
  );

  /** 这步选的变换是否不在下拉里（已被注销，或历史数据里存了个执行类） */
  const isDangling = (id: string) => !!id && !stepOptions.some((t) => t.id === id);

  const setStep = (i: number, transformId: string) => {
    const t = stepOptions.find((x) => x.id === transformId);
    // risk 统一走 riskOf（与 AI 编链的 planner 共用同一份推导，见规则 #11）
    const step: ChainStep = {
      transformId,
      risk: riskOf(t),
    };
    setDraft((d) => {
      const steps = [...d.steps];
      steps[i] = step;
      return { ...d, steps };
    });
  };

  /** v6.3 条件执行：给某步设执行条件（undefined = always 无条件） */
  const setCondition = (i: number, type: string) => {
    setDraft((d) => {
      const steps = [...d.steps];
      const s = { ...steps[i] };
      if (type === "always") delete s.condition;
      else s.condition = { type } as ChainStep["condition"];
      steps[i] = s;
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
    // 分层约定：步骤引用的变换是否存在，由前端（变换注册表）在保存前校验——
    // 后端不认识前端注册表（data_store/chains.rs 顶部注释）。之前两侧都没校，
    // 悬空 id（如编辑一条引用了已删自定义 AI 动作的旧链）能一路存进库，
    // 跑起来才停在「变换不存在（未注册）」。
    const missingIdx = draft.steps.findIndex((s) => !getTransform(s.transformId));
    if (missingIdx >= 0) {
      toast(`第 ${missingIdx + 1} 步的变换已失效，请重新选一个`, "warning");
      return;
    }
    // 执行类有副作用且不产出文本；下拉已排除，这里拦手工构造 / 历史数据绕过
    const actionIdx = draft.steps.findIndex(
      (s) => getTransform(s.transformId)?.kind === "action",
    );
    if (actionIdx >= 0) {
      toast(`第 ${actionIdx + 1} 步是执行类动作（有副作用），不能放进链`, "warning");
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
    // 审查：删除链不可恢复，统一确认弹窗（此前 window.confirm 与全站风格割裂）
    const ok = await confirmDialog({
      title: "删除链",
      message: `删除链「${draft.name}」？此操作不可恢复。`,
      confirmText: "删除",
    });
    if (!ok) return;
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
                <label className={styles.label}>
                  名称 <span className={styles.charCount}>{draft.name.length}/{MAX_CHAIN_NAME_CHARS}</span>
                </label>
                <input
                  className={styles.input}
                  value={draft.name}
                  maxLength={MAX_CHAIN_NAME_CHARS}
                  placeholder="如：报错处理流水线"
                  onChange={(e) => patch({ name: e.target.value })}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>
                  描述（可选） <span className={styles.charCount}>{draft.description.length}/60</span>
                </label>
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
                  <Fragment key={i}>
                    <div className={styles.editStep}>
                      <div className={styles.editStepRow}>
                        <span className={styles.editIdx}>{i + 1}</span>
                        <select
                          className={styles.sel}
                          value={s.transformId}
                          onChange={(e) => setStep(i, e.target.value)}
                        >
                          <option value="">选择变换…</option>
                          {/* 兜住悬空 id，否则受控 select 显示空白，用户看不出这步原本是什么 */}
                          {isDangling(s.transformId) && (
                            <option value={s.transformId}>{danglingLabel(s.transformId)}</option>
                          )}
                          {stepOptions.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.label}
                              {t.remote ? "（AI）" : ""}
                            </option>
                          ))}
                        </select>
                        <span className={`${styles.riskChip} ${s.risk === "network" ? styles.riskNet : s.risk === "destructive" ? styles.riskDanger : styles.riskLocal}`}>
                          {RISK_LABEL[s.risk] ?? s.risk}
                        </span>
                        <select
                          className={styles.condSel}
                          value={s.condition?.type ?? "always"}
                          onChange={(e) => setCondition(i, e.target.value)}
                          title="执行条件：不满足时该步自动跳过"
                        >
                          <option value="always">无条件</option>
                          <option value="is-json">是 JSON 时</option>
                          <option value="contains-secret">含敏感时</option>
                          <option value="is-code">是代码时</option>
                        </select>
                        <span className={styles.editBtns}>
                          <button className={styles.iconBtn} onClick={() => move(i, -1)} disabled={i === 0} title="上移">
                            <ChevronUp size={13} />
                          </button>
                          <button className={styles.iconBtn} onClick={() => move(i, 1)} disabled={i === draft.steps.length - 1} title="下移">
                            <ChevronDown size={13} />
                          </button>
                          <button className={`${styles.iconBtn} ${styles.delBtn}`} onClick={() => removeStep(i)} title="删除此步">
                            <Trash2 size={13} />
                          </button>
                        </span>
                      </div>
                      {/* v6.10：条件说明提示（非无条件时解释跳过语义） */}
                      {s.condition && (
                        <div className={styles.condHint}>
                          ⚠ {COND_HINT[s.condition.type] ?? "满足条件才执行这步"}
                        </div>
                      )}
                      {!s.transformId && (
                        <div className={styles.editHint}>从下拉里选一个变换</div>
                      )}
                      {isDangling(s.transformId) && (
                        <div className={`${styles.editHint} ${styles.danglingHint}`}>
                          ⚠ 这一步的变换已不可用（被删除 / 停用，或不允许用于链），请重新选一个
                        </div>
                      )}
                    </div>
                    {i < draft.steps.length - 1 && <div className={styles.stepConnector} />}
                  </Fragment>
                ))}
              </div>

              <button className={styles.addStep} onClick={addStep}>
                <Plus size={13} /> 添加步骤（{draft.steps.length}/{MAX_STEPS}）
              </button>

              <div className={styles.editActions}>
                {draft.id ? (
                  <button className={styles.delChain} onClick={() => void remove()}>
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
