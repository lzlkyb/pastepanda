/**
 * 专注模式的浮层 chrome（稿子 P1-3 / 屏幕②）：纯展示。
 *
 * 三个部分，全部**绝对定位于 overlay**，不参与文档流：
 *   - 顶部 48px 悬停热区 + 迷你工具栏（默认上滑藏起，悬停/键盘聚焦滑出）；
 *   - 右上角保存徽章常驻钉 —— 规则 15：保存状态栏被专注模式隐藏了，
 *     失败反馈绝不能跟着消失，所以徽章在这里**再钉一份**（同一份 SaveBadge）；
 *   - 进入提示 toast（延时自关，不是唯一出口线索）。
 *
 * 隐藏 chrome 的方式是 overlay 上的 `.focusMode` 类（CSS），本组件只负责「该出现的浮层」。
 */
import { X } from "lucide-react";
import { SaveBadge } from "./EditorStatusBar";
import styles from "../FullscreenEditor.module.css";

interface FocusChromeProps {
  icon: string;
  fileName: string;
  isDirty: boolean;
  isSaving: boolean;
  autoSaveError: boolean;
  /** 徽章钉点击 = 手动保存（= Ctrl+S 同源回调） */
  onSave: () => void;
  onExit: () => void;
  toastVisible: boolean;
}

export function FocusChrome({
  icon,
  fileName,
  isDirty,
  isSaving,
  autoSaveError,
  onSave,
  onExit,
  toastVisible,
}: FocusChromeProps) {
  return (
    <>
      {/* 悬停热区：顶部长条，把迷你工具栏「唤」出来 */}
      <div className={styles.focusTbHotzone} />
      <div className={styles.focusTb}>
        <div className={styles.fileIcon}>{icon}</div>
        <span className={styles.focusTbName}>{fileName}</span>
        <button type="button" className={styles.focusTbExit} onClick={onExit}>
          <X size={12} />
          退出专注 <kbd>Esc</kbd>
        </button>
      </div>

      {/* 保存徽章常驻钉（失败态可点击重试 = Ctrl+S） */}
      <button
        type="button"
        className={styles.focusSavePin}
        onClick={onSave}
        title="保存 Ctrl+S"
      >
        <SaveBadge isDirty={isDirty} isSaving={isSaving} autoSaveError={autoSaveError} />
      </button>

      {toastVisible && (
        <div className={styles.focusToast}>
          已进入专注模式 · <kbd>Esc</kbd> 退出 · 鼠标移到顶部显示工具栏
        </div>
      )}
    </>
  );
}
