import { useState, useCallback, useEffect, useMemo } from "react";
import { motion } from "framer-motion";
import { X, Pencil, Trash2 } from "lucide-react";
import { useDialogAnim } from "@/lib/dialogMotion";
import {
  getAllRules, togglePresetRule, toggleCustomRule,
  addCustomRule, updateCustomRule, deleteCustomRule,
  validateRegex, safeApplyRegex, type RegexRule,
} from "@/lib/regexRules";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import styles from "./RegexRulesDialog.module.css";
import { FocusTrap } from "@/components/FocusTrap";

interface RegexRulesDialogProps {
  onClose: () => void;
}

interface EditState {
  id: string | null;
  name: string;
  pattern: string;
  replacement: string;
  flags: string;
  isNew: boolean;
}

const emptyEdit: EditState = { id: null, name: "", pattern: "", replacement: "", flags: "g", isNew: false };

export function RegexRulesDialog({ onClose }: RegexRulesDialogProps) {
  const anim = useDialogAnim();
  const [rules, setRules] = useState<RegexRule[]>(() => getAllRules());
  const [edit, setEdit] = useState<EditState>(emptyEdit);
  const [deleteTarget, setDeleteTarget] = useState<RegexRule | null>(null);

  const refresh = useCallback(() => setRules(getAllRules()), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleToggle = useCallback((rule: RegexRule) => {
    if (rule.preset) togglePresetRule(rule.id);
    else toggleCustomRule(rule.id);
    refresh();
  }, [refresh]);

  const confirmDelete = useCallback(() => {
    if (!deleteTarget) return;
    deleteCustomRule(deleteTarget.id);
    setDeleteTarget(null);
    refresh();
  }, [deleteTarget, refresh]);

  const startEdit = useCallback((rule: RegexRule) => {
    setEdit({ id: rule.id, name: rule.name, pattern: rule.pattern, replacement: rule.replacement, flags: rule.flags, isNew: false });
  }, []);

  const startAdd = useCallback(() => {
    setEdit({ ...emptyEdit, isNew: true });
  }, []);

  const editError = edit.pattern ? validateRegex(edit.pattern, edit.flags) : null;

  // U48："试一试"实时预览 — 用当前编辑中的规则对示例文本做替换（ReDoS 安全）
  const [testText, setTestText] = useState("");
  const testPreview = useMemo(() => {
    if (!testText || !edit.pattern || editError) return null;
    try {
      const { result, matchCount } = safeApplyRegex(testText, edit.pattern, edit.replacement, edit.flags);
      return { result, matchCount };
    } catch {
      return null;
    }
  }, [testText, edit.pattern, edit.replacement, edit.flags, editError]);

  const handleSave = useCallback(() => {
    if (!edit.name.trim() || !edit.pattern) return;
    if (editError) return;
    if (edit.isNew) {
      addCustomRule({ name: edit.name.trim(), pattern: edit.pattern, replacement: edit.replacement, flags: edit.flags, enabled: true });
    } else if (edit.id && edit.id.startsWith("c_")) {
      updateCustomRule(edit.id, { name: edit.name.trim(), pattern: edit.pattern, replacement: edit.replacement, flags: edit.flags });
    }
    setEdit(emptyEdit);
    refresh();
  }, [edit, editError, refresh]);

  return (
    <motion.div
      {...anim.backdrop}
      className="dialog-backdrop" onClick={onClose}>
      <FocusTrap>
      <motion.div
        {...anim.panel}
        className={`dialog-box ${styles.rulesDialog}`}
        onClick={(e) => e.stopPropagation()}>

          <div className="dialog-header">
            <h2 className="dialog-title">⚙ 正则规则管理</h2>
            <button onClick={onClose} className="dialog-close"><X size={16} /></button>
          </div>

          <div className={styles.rulesBody}>
            {/* Edit form */}
            {(edit.isNew || edit.id) && (
              <div className={styles.editForm}>
                <div className={styles.editRow}>
                  <span className={styles.editLabel}>名称</span>
                  <input className={styles.editInput} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="规则名称" />
                </div>
                <div className={styles.editRow}>
                  <span className={styles.editLabel}>匹配</span>
                  <input className={`${styles.editInput}${editError ? ` ${styles.editInputError}` : ""}`} value={edit.pattern} onChange={(e) => setEdit({ ...edit, pattern: e.target.value })} placeholder="正则表达式" spellCheck={false} />
                </div>
                <div className={styles.editRow}>
                  <span className={styles.editLabel}>替换</span>
                  <input className={styles.editInput} value={edit.replacement} onChange={(e) => setEdit({ ...edit, replacement: e.target.value })} placeholder="替换为（支持 $1 $2）" spellCheck={false} />
                </div>
                <div className={styles.editRow}>
                  <span className={styles.editLabel}>标志</span>
                  <input className={styles.editInput} style={{ width: 60, flex: "none" }} value={edit.flags} onChange={(e) => setEdit({ ...edit, flags: e.target.value })} spellCheck={false} />
                </div>
                {/* U48：试一试 — 输入示例文本实时验证规则效果 */}
                <div className={styles.editRow}>
                  <span className={styles.editLabel}>试一试</span>
                  <input className={styles.editInput} value={testText} onChange={(e) => setTestText(e.target.value)} placeholder="输入示例文本，实时预览替换效果" spellCheck={false} />
                </div>
                {testText && edit.pattern && !editError && (
                  <div className={styles.testPreview}>
                    <span className={styles.testPreviewCount}>匹配 {testPreview?.matchCount ?? 0} 处</span>
                    <span className={styles.testPreviewResult}>{testPreview ? testPreview.result : "（替换失败）"}</span>
                  </div>
                )}
                {editError && <div className={styles.editError}>⚠ {editError}</div>}
                <div className={styles.editBtns}>
                  <button className={styles.editBtn} onClick={() => setEdit(emptyEdit)}>取消</button>
                  <button className={`${styles.editBtn} ${styles.editBtnSave}`} onClick={handleSave} disabled={!edit.name.trim() || !edit.pattern || !!editError}>保存</button>
                </div>
              </div>
            )}

            {/* Rule list */}
            {rules.map((rule) => (
              <div key={rule.id} className={styles.ruleRow}>
                <button
                  className={`${styles.toggle}${rule.enabled ? ` ${styles.toggleOn}` : ""}`}
                  onClick={() => handleToggle(rule)}
                  title={rule.enabled ? "禁用" : "启用"}
                />
                <div className={styles.ruleInfo}>
                  <div className={styles.ruleName}>{rule.name}</div>
                  <div className={styles.rulePattern}>/{rule.pattern}/{rule.flags} → "{rule.replacement}"</div>
                </div>
                <span className={`${styles.badge} ${rule.preset ? styles.badgePreset : styles.badgeCustom}`}>
                  {rule.preset ? "预设" : "自定义"}
                </span>
                <div className={styles.ruleActions}>
                  {!rule.preset && (
                    <button className={styles.actionBtn} title="编辑" onClick={() => startEdit(rule)}><Pencil size={12} /></button>
                  )}
                  {!rule.preset && (
                    <button className={`${styles.actionBtn} ${styles.actionBtnDel}`} title="删除" onClick={() => setDeleteTarget(rule)}><Trash2 size={12} /></button>
                  )}
                </div>
              </div>
            ))}

            <button className={styles.addBtn} onClick={startAdd}>＋ 添加自定义规则</button>
          </div>

          {/* 删除确认弹窗 */}
          <ConfirmDialog
            open={!!deleteTarget}
            title="确认删除规则"
            message={`确定删除自定义规则"${deleteTarget?.name}"？此操作不可撤销。`}
            confirmText="删除"
            variant="danger"
            onConfirm={confirmDelete}
            onCancel={() => setDeleteTarget(null)}
          />
        </motion.div>
        </FocusTrap>
      </motion.div>
  );
}
