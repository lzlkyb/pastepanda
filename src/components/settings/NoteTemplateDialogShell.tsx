/**
 * 转笔记模板两个弹窗的外壳（B2 #8）。
 *
 * 外壳完全走已有的全局弹窗体系（`dialog-backdrop` / `dialog-box` / `dialog-header` /
 * `dialog-body` / `dialog-footer`）+ `FocusTrap` + `useDialogAnim`，做法照 `DeepCleanDialog`
 * （同样从设置页打开的弹窗）——不另开一套，风格不一致就是这么来的。
 *
 * **两个弹窗共用一份壳**（规则 #11）：ESC / 遮罩 / ✕ / 取消 四条关闭路径都要走
 * 同一个「有未保存改动先问一句」，写两份必定漏一条。
 * 嵌套确认框本身是支持的：`ConfirmDialog` 用 `.z-confirm`（z=600），就是为「从弹窗里再弹」准备的。
 */
import { useCallback } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { FocusTrap } from "@/components/FocusTrap";
import { useDialogAnim } from "@/lib/dialogMotion";
import { confirmDialog } from "@/lib/confirm";
import { useDialogEscape } from "@/hooks/useDialogEscape";

interface Props {
  open: boolean;
  title: string;
  /** 有未保存改动——关闭前会先问一句 */
  dirty: boolean;
  /** 确定要关（已确认放弃）时调 */
  onClose: () => void;
  onSave: () => void;
  /** 保存按钮文案，默认「保存」 */
  saveText?: string;
  children: React.ReactNode;
}

export function NoteTemplateDialogShell({
  open,
  title,
  dirty,
  onClose,
  onSave,
  saveText = "保存",
  children,
}: Props) {
  const anim = useDialogAnim();

  const tryClose = useCallback(async () => {
    if (!dirty) {
      onClose();
      return;
    }
    const ok = await confirmDialog({
      title: "放弃未保存的模板改动？",
      message: "刚敲的模板还没保存，关掉就丢了。",
      confirmText: "放弃改动",
      cancelText: "继续编辑",
      variant: "warning",
    });
    if (ok) onClose();
  }, [dirty, onClose]);

  // Esc 关闭（同样过一道未保存确认）。
  // 公共 hook：捕获期 + stopPropagation——本弹窗从设置页打开，不阻断的话
  // App 的 Esc 链会把**整个设置页**一起关掉，而那条路径连未保存确认都跳过了。
  const escClose = useCallback(() => { void tryClose(); }, [tryClose]);
  useDialogEscape(escClose, open);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          {...anim.backdrop}
          className="dialog-backdrop"
          onClick={() => void tryClose()}
        >
          <FocusTrap>
            <motion.div
              {...anim.panel}
              className="dialog-box w520"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="dialog-header">
                <h2 className="dialog-title">{title}</h2>
                <button onClick={() => void tryClose()} className="dialog-close">
                  <X size={16} />
                </button>
              </div>

              <div className="dialog-body">{children}</div>

              <div className="dialog-footer">
                <button className="btn-secondary" onClick={() => void tryClose()}>
                  取消
                </button>
                <button className="btn-primary" onClick={onSave} disabled={!dirty}>
                  {saveText}
                </button>
              </div>
            </motion.div>
          </FocusTrap>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
