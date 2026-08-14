/**
 * StackTemplateDialog.tsx —— P4 粘贴栈常用模板：存为模板 / 模板库载入。
 * 两个弹窗共用同一份小样式文件，逻辑简单故不拆两个文件。
 */
import { memo, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { useAppStore, type HistoryItem } from "@/stores/appStore";
import { useToast } from "@/components/Toast";
import { useDialogAnim } from "@/lib/dialogMotion";
import { FocusTrap } from "@/components/FocusTrap";
import { confirmDialog } from "@/lib/confirm";
import { maskSensitiveText } from "@/lib/mask";
import { relativeTime } from "@/lib/utils";
import {
  saveStackTemplate,
  listStackTemplates,
  deleteStackTemplate,
  touchStackTemplate,
  stackItemsToTemplateItems,
  type StackTemplate,
} from "@/lib/api/stackTemplate";
import styles from "./StackTemplateDialog.module.css";

/** 存为模板：把当前栈的未粘贴条目存成一份可复用模板 */
export const SaveTemplateDialog = memo(function SaveTemplateDialog({
  items,
  onClose,
}: {
  items: HistoryItem[];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const { backdrop, panel } = useDialogAnim();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [sensitiveAck, setSensitiveAck] = useState(false);

  // 检测这批内容里有没有疑似敏感信息（密钥/手机号/邮箱/身份证/IP）——
  // 模板是长期复用的，不像普通历史有自动清理，值得多问一句。
  const sensitiveCount = useMemo(
    () => items.reduce((n, it) => n + maskSensitiveText(it.text || "").count, 0),
    [items],
  );

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast("模板名称不能为空", "error");
      return;
    }
    if (sensitiveCount > 0 && !sensitiveAck) {
      toast("请先确认要长期保存这批内容", "info");
      return;
    }
    setSaving(true);
    try {
      await saveStackTemplate(trimmed, stackItemsToTemplateItems(items));
      toast(`已存为模板「${trimmed}」`, "success");
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <AnimatePresence>
      <motion.div {...backdrop} className="dialog-backdrop" onClick={onClose}>
        <FocusTrap>
          <motion.div {...panel} className="dialog-box w420" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-header">
              <h2 className="dialog-title">存为模板</h2>
              <span className={styles.headerSub}>当前栈 {items.length} 条</span>
              <button onClick={onClose} className="dialog-close" aria-label="关闭">
                <X size={16} />
              </button>
            </div>

            <div className="dialog-body">
              <div>
                <div className={styles.fieldLabel}>模板名称</div>
                <input
                  className={styles.nameInput}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="如：周报引用、报销单、客户信息"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
                />
              </div>

              {sensitiveCount > 0 && (
                <div className={styles.sensBox}>
                  <span>🔒</span>
                  <div>
                    <b>检测到疑似敏感内容</b>：这批条目里有 {sensitiveCount} 处像密钥/手机号/邮箱/身份证等信息。
                    模板会长期保留、反复复用，不像普通历史那样有自动清理。
                    <label className={styles.sensCk}>
                      <input
                        type="checkbox"
                        checked={sensitiveAck}
                        onChange={(e) => setSensitiveAck(e.target.checked)}
                      />
                      我确认要长期保存此内容
                    </label>
                  </div>
                </div>
              )}

              <div className={styles.itemList}>
                {items.map((it, i) => (
                  <div key={it.id} className={styles.itemRow}>
                    <span className={styles.itemOrd}>{i + 1}</span>
                    <span className={styles.itemText}>
                      {it.text?.trim() || (it.type === "image" ? "[图片]" : it.type === "file" ? "[文件]" : "(空)")}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="dialog-footer">
              <div className="dialog-footer-right">
                <button className={styles.ghostBtn} onClick={onClose}>取消</button>
                <button className={styles.primaryBtn} onClick={() => void save()} disabled={saving}>
                  {saving ? "保存中…" : "保存模板"}
                </button>
              </div>
            </div>
          </motion.div>
        </FocusTrap>
      </motion.div>
    </AnimatePresence>
  );
});

/** 模板库：列出已存模板，可载入到当前栈 / 删除 */
export const TemplateLibraryDialog = memo(function TemplateLibraryDialog({
  onClose,
}: {
  onClose: () => void;
}) {
  const { toast } = useToast();
  const { backdrop, panel } = useDialogAnim();
  const [templates, setTemplates] = useState<StackTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const stackItems = useAppStore((s) => s.stackItems);
  const stackLoadTemplate = useAppStore((s) => s.stackLoadTemplate);

  useEffect(() => {
    let alive = true;
    listStackTemplates()
      .then((list) => { if (alive) setTemplates(list); })
      .catch((e) => toast(e instanceof Error ? e.message : String(e), "error"))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = async (tpl: StackTemplate) => {
    // 载入会替换当前未粘贴内容，需先征得用户确认（对齐红线①不自动执行）
    if (stackItems.length > 0) {
      const ok = await confirmDialog({
        title: "载入模板",
        message: `将替换当前 ${stackItems.length} 条未粘贴内容，已粘贴过的记录不受影响。`,
        confirmText: "载入",
      });
      if (!ok) return;
    }
    stackLoadTemplate(
      tpl.items.map((it) => ({
        type: it.itemType as HistoryItem["type"],
        text: it.text,
        content: it.content,
      })),
    );
    void touchStackTemplate(tpl.id).catch(() => {});
    toast(`已载入「${tpl.name}」`, "success");
    onClose();
  };

  const remove = async (tpl: StackTemplate) => {
    const ok = await confirmDialog({
      title: "删除模板",
      message: `删除模板「${tpl.name}」？此操作不可恢复。`,
      confirmText: "删除",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await deleteStackTemplate(tpl.id);
      setTemplates((prev) => prev.filter((t) => t.id !== tpl.id));
      toast(`已删除「${tpl.name}」`, "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  return (
    <AnimatePresence>
      <motion.div {...backdrop} className="dialog-backdrop" onClick={onClose}>
        <FocusTrap>
          <motion.div {...panel} className="dialog-box w420" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-header">
              <h2 className="dialog-title">模板库</h2>
              <span className={styles.headerSub}>共 {templates.length} 个模板</span>
              <button onClick={onClose} className="dialog-close" aria-label="关闭">
                <X size={16} />
              </button>
            </div>

            <div className="dialog-body">
              {loading ? (
                <div className={styles.emptyHint}>加载中…</div>
              ) : templates.length === 0 ? (
                <div className={styles.emptyHint}>还没有存过模板，先在栈横幅「⋯」菜单里点「📌 存为模板」试试</div>
              ) : (
                <div className={styles.itemList}>
                  {templates.map((tpl) => (
                    <div key={tpl.id} className={styles.tplRow}>
                      <span className={styles.tplName}>{tpl.name}</span>
                      <span className={styles.tplMeta}>{tpl.items.length} 条</span>
                      <span className={styles.tplMeta}>
                        {tpl.usedAt ? relativeTime(tpl.usedAt) : "从未用过"}
                      </span>
                      <button className={styles.miniLoad} onClick={() => void load(tpl)}>载入</button>
                      <button className={styles.miniDel} onClick={() => void remove(tpl)}>删</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        </FocusTrap>
      </motion.div>
    </AnimatePresence>
  );
});
