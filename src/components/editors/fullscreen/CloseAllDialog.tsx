/**
 * 多标签关闭守卫（聚合清单）。
 *
 * 为什么是「一次列清」而不是「逐个弹三选一」：关窗时若开着 5 个未保存的文档，
 * 逐个弹就是 5 次弹窗，用户点到第三轮已经开始盲点；而且他看不到「一共几个、
 * 分别是什么」。聚合清单让这件事一次说清。
 *
 * ❗ 与 `ConfirmDialog` 同源的取舍（读那边的注释）：按 Esc 必须等于「取消」。
 *    本组件直接复用它的做法（capture 阶段 + stopPropagation），
 *    因为底下的编辑器也在监听 Esc 关窗 —— 不拦就是「一按 Esc 既取消又关窗」。
 *
 * 按钮语义三分（沿用三个不丢东西的默认）：
 *   - 取消          —— 唯一百分百不丢东西的路，默认焦点与 Esc 都归它
 *   - 不保存        —— 危险但显式的路径
 *   - 全部保存并关闭 —— 会逐个真写盘；任一失败就**不关窗**（把失败留在用户眼前，
 *                      而不是关完窗口再告诉他「有一个没存上」）
 */
import { useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { createPortal } from "react-dom";
import { X, AlertTriangle } from "lucide-react";
import { FocusTrap } from "@/components/FocusTrap";
import { useDialogAnim } from "@/lib/dialogMotion";
import styles from "./CloseAllDialog.module.css";

export interface CloseTarget {
  id: string;
  fileName: string;
  /** 自动保存写盘失败 —— 这一类必须单独标出来：用户以为自动保存在跑 */
  tabError: boolean;
  /**
   * 该文档**有没有保存能力**（false = 无处可存，如文本对比全屏）。
   *
   * 必须与 `tabError` 区分：`tabError` 是「试着存了但失败」，这个是「本来就没得存」。
   * 混为一谈的后果是：主按钮承诺「保存并关闭」，而对无保存目标的文档它必然做不到 ——
   * 用户点了报错，还找不到任何保存入口（工具栏上根本没那个按钮）。
   */
  canSave: boolean;
}

interface CloseAllDialogProps {
  open: boolean;
  /** "tab" = 关单个标签；"window" = 关整个窗口 */
  scope: "tab" | "window";
  targets: CloseTarget[];
  /** 正在逐个写盘（按钮禁用 + 文案转换） */
  busy: boolean;
  onSaveAll: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

export function CloseAllDialog({
  open,
  scope,
  targets,
  busy,
  onSaveAll,
  onDiscard,
  onCancel,
}: CloseAllDialogProps) {
  const anim = useDialogAnim();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (!busy) onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onCancel, busy]);

  const title = scope === "tab" ? "还有未保存的修改" : `有 ${targets.length} 个文档未保存`;
  const failCount = targets.filter((t) => t.tabError).length;
  /** 清单里只要还有一个能存，主按钮就保留「保存」语义 */
  const anySave = targets.some((t) => t.canSave);
  /**
   * ❗ 全是无处可存的文档时，按钮**不能**继续叫「保存并关闭」—— 它必然做不到，
   * 用户点了只会看到一句「未能保存」，然后在界面上找不到任何保存入口
   * （那些文档的工具栏本来就没有保存按钮）。此时唯一可能的行为是「关掉并丢弃」，
   * 按钮就该照实说。
   */
  const primaryLabel = anySave
    ? scope === "tab"
      ? "保存并关闭"
      : "全部保存并关闭"
    : "仍然关闭";

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          {...anim.backdrop}
          className="dialog-backdrop z-confirm"
          onClick={busy ? undefined : onCancel}
        >
          <FocusTrap initialFocus="[data-autofocus]">
            <motion.div
              {...anim.panel}
              className="dialog-box w400"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="dialog-header">
                <div className={styles.head}>
                  <AlertTriangle size={16} className={styles.headIcon} />
                  <h2 className="dialog-title">{title}</h2>
                </div>
                <button onClick={onCancel} className="dialog-close" disabled={busy}>
                  <X size={16} />
                </button>
              </div>

              {/* Body：逐条列清「哪些没存、为什么没存」 */}
              <div className="dialog-body" style={{ "--dialog-body-gap": "12px" } as React.CSSProperties}>
                <p className={styles.lead}>
                  {scope === "tab"
                    ? "如果现在关闭，这个文档里未保存的修改将不会保留。"
                    : "下面这些文档还有未保存的修改："}
                </p>
                <ul className={styles.list}>
                  {targets.map((t) => (
                    <li key={t.id} className={styles.item}>
                      <span className={styles.itemName} title={t.fileName}>
                        {t.fileName}
                      </span>
                      <span
                        className={
                          t.tabError ? `${styles.itemTag} ${styles.itemTagErr}` : styles.itemTag
                        }
                      >
                        {t.tabError ? "自动保存失败" : t.canSave ? "未保存" : "无保存目标"}
                      </span>
                    </li>
                  ))}
                </ul>
                {failCount > 0 && (
                  <p className={styles.failNote}>
                    其中 {failCount} 个文档自动保存失败（目标不可写），「保存并关闭」可能同样失败。
                  </p>
                )}
              </div>

              {/* Footer：靠右用全局 .dialog-footer-right，不再写内联 justifyContent */}
              <div className="dialog-footer">
                <div className="dialog-footer-right">
                  <div className={styles.footerActions}>
                    {/* 安全默认：取消是唯一不丢东西的路，默认焦点与 Esc 都归它 */}
                    <button
                      className="btn-secondary"
                      onClick={onCancel}
                      disabled={busy}
                      autoFocus
                      data-autofocus
                    >
                      取消
                    </button>
                    <button className="btn-danger" onClick={onDiscard} disabled={busy}>
                      不保存
                    </button>
                    <button className="btn-primary" onClick={onSaveAll} disabled={busy}>
                      {busy ? "保存中…" : primaryLabel}
                    </button>
                  </div>
                </div>
              </div>
            </motion.div>
          </FocusTrap>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
