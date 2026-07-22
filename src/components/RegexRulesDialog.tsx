import { useState, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Pencil, Trash2 } from "lucide-react";
import {
  getAllRules, togglePresetRule, toggleCustomRule,
  addCustomRule, updateCustomRule, deleteCustomRule,
  validateRegex, type RegexRule,
} from "@/lib/regexRules";
import styles from "./RegexRulesDialog.module.css";

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
  const [rules, setRules] = useState<RegexRule[]>(() => getAllRules());
  const [edit, setEdit] = useState<EditState>(emptyEdit);

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

  const handleDelete = useCallback((id: string) => {
    deleteCustomRule(id);
    refresh();
  }, [refresh]);

  const startEdit = useCallback((rule: RegexRule) => {
    setEdit({ id: rule.id, name: rule.name, pattern: rule.pattern, replacement: rule.replacement, flags: rule.flags, isNew: false });
  }, []);

  const startAdd = useCallback(() => {
    setEdit({ ...emptyEdit, isNew: true });
  }, []);

  const editError = edit.pattern ? validateRegex(edit.pattern, edit.flags) : null;

  const handleSave = useCallback(() => {
    if (!edit.name.trim() || !edit.pattern) return;
    if (editError) return;
    if (edit.isNew) {
      addCustomRule({ name: edit.name.trim(), pattern: edit.pattern, replacement: edit.replacement, flags: edit.flags, enabled: true });
    } else if (edit.id) {
      if (edit.id.startsWith("c_")) {
        updateCustomRule(edit.id, { name: edit.name.trim(), pattern: edit.pattern, replacement: edit.replacement, flags: edit.flags });
      } else {
        // 预设规则只能改 replacement 和 flags（通过自定义覆盖方式暂不支持，仅自定义可编辑全部字段）
        updateCustomRule(edit.id, { name: edit.name.trim(), pattern: edit.pattern, replacement: edit.replacement, flags: edit.flags });
      }
    }
    setEdit(emptyEdit);
    refresh();
  }, [edit, editError, refresh]);

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="dialog-backdrop" onClick={onClose}>
        <motion.div
          initial={{ scale: 0.96, opacity: 0, y: 10 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.96, opacity: 0, y: 10 }}
          transition={{ type: "spring", stiffness: 400, damping: 30 }}
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
                  <button className={styles.actionBtn} title="编辑" onClick={() => startEdit(rule)}><Pencil size={12} /></button>
                  {!rule.preset && (
                    <button className={`${styles.actionBtn} ${styles.actionBtnDel}`} title="删除" onClick={() => handleDelete(rule.id)}><Trash2 size={12} /></button>
                  )}
                </div>
              </div>
            ))}

            <button className={styles.addBtn} onClick={startAdd}>＋ 添加自定义规则</button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
