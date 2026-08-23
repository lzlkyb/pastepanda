/**
 * FullscreenShell —— 全屏编辑器的「通用外壳」复用层。
 *
 * 背景：rich / diagram / diff 三类不走 CodeMirror 单栏机制（FullscreenInner），
 * 之前各自平行重写工具栏 / 主题判定 / 全屏切换 / 关闭守卫 / 状态栏，
 * 导致与 single 类（markdown/json/...）观感一致但代码重复、且主题判定
 * 硬编码 midnight||ocean-dark（加主题必漏判）。
 *
 * 本壳把上面这些「外壳能力」收敛到一处，类型差异通过插槽传入：
 *   - leftExtra / rightExtra：类型专属工具栏按钮（如 diff 模式切换、diagram AI/Mermaid）
 *   - children：主体内容区
 *   - statusLeft / statusRight：状态栏节点（各类型不同，交给调用方）
 *   - onSave：传入则显示「保存」按钮并接管 Ctrl+S；不传则无保存入口
 *   - dirty：驱动 unsavedDot + 关闭守卫
 *
 * 主题判定统一走 THEMES 查表（与 FullscreenInner 同口径），灭掉硬编码。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Save, X, Maximize2, Minimize2 } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DEFAULT_THEME, THEMES, type ThemeKey } from "@/lib/theme";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SkinScene } from "@/components/SkinScene";
import { logger } from "@/lib/logger";
import styles from "./FullscreenEditor.module.css";

export interface FullscreenShellProps {
  /** 工具栏图标（emoji 或字符，如 🔀 / 📊 / 🖼️） */
  icon: string;
  /** 工具栏标题（文件名 / 内容类型名） */
  title: string;
  /** 是否脏（显示 unsavedDot + 关闭前守卫） */
  dirty: boolean;
  /** 保存回调；传入则显示「保存」按钮并接管 Ctrl+S */
  onSave?: () => void | Promise<boolean>;
  /** 关闭回调（守卫通过后调用） */
  onClose: () => void;
  /** 工具栏左侧类型专属按钮（在标题之后、保存按钮之前） */
  leftExtra?: ReactNode;
  /** 工具栏右侧类型专属按钮（在「全屏 / 关闭」之前） */
  rightExtra?: ReactNode;
  /** 主体内容区 */
  children: ReactNode;
  /** 状态栏左侧节点 */
  statusLeft?: ReactNode;
  /** 状态栏右侧节点 */
  statusRight?: ReactNode;
}

export function FullscreenShell({
  icon,
  title,
  dirty,
  onSave,
  onClose,
  leftExtra,
  rightExtra,
  children,
  statusLeft,
  statusRight,
}: FullscreenShellProps) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isDarkTheme, setIsDarkTheme] = useState(false);
  const [showConfirmClose, setShowConfirmClose] = useState(false);
  // dirty 由调用方通过 prop 实时传入；直接用最新值即可（无需 ref 桥接）
  const isDirty = dirty;

  // 主题判定：统一走 THEMES 查表（与 FullscreenInner 同口径），灭掉各类型硬编码 midnight||ocean-dark
  useEffect(() => {
    const applyTheme = (theme: string) => {
      const themeKey = (theme || DEFAULT_THEME) as ThemeKey;
      const themeDef = THEMES.find((t) => t.key === themeKey);
      setIsDarkTheme(themeDef ? themeDef.dark : false);
    };
    invoke<{ theme?: string }>("get_config")
      .then((cfg) => applyTheme(cfg.theme ?? DEFAULT_THEME))
      .catch(() => { /* 读不到就保持默认亮色 */ });
    // 运行时主题切换也跟随（独立窗口拿不到主窗口 store，只能监听事件）
    const unsubPromise = listen<{ theme?: string }>("theme-changed", (e) => applyTheme(e.payload?.theme ?? DEFAULT_THEME));
    return () => { void unsubPromise.then((u) => u()); };
  }, []);

  const toggleFullscreen = useCallback(async () => {
    try {
      const win = getCurrentWindow();
      const next = !(await win.isFullscreen());
      await win.setFullscreen(next);
      setIsFullscreen(next);
    } catch (e) {
      logger.error("切换全屏失败", e);
    }
  }, []);

  const handleSave = useCallback(async (): Promise<boolean> => {
    if (!onSave) return false;
    try {
      const r = await onSave();
      return r !== false;
    } catch {
      return false;
    }
  }, [onSave]);

  // 关闭守卫：脏 → 先确认；否则直接关
  const guardedClose = useCallback(() => {
    if (isDirty) {
      setShowConfirmClose(true);
      return;
    }
    onClose();
  }, [isDirty, onClose]);

  const handleConfirmClose = useCallback(() => {
    setShowConfirmClose(false);
    onClose();
  }, [onClose]);

  // 快捷键：Ctrl+S 保存（有 onSave）/ Esc 关闭守卫
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        if (onSave) {
          e.preventDefault();
          void handleSave();
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        guardedClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSave, handleSave, guardedClose]);

  return (
    <div className={styles.overlay} data-theme-mode={isDarkTheme ? "dark" : "light"}>
      <SkinScene />
      {/* Toolbar（deep 拖拽区：按住文件名/图标/空白处可移动窗口，按钮自动豁免） */}
      <div className={styles.toolbar} data-tauri-drag-region="deep">
        <div className={styles.toolbarLeft}>
          <div className={styles.fileIcon}>{icon}</div>
          <span className={styles.fileName}>{title}</span>
          {isDirty && <div className={styles.unsavedDot} />}
          {leftExtra}
        </div>
        <div className={styles.toolbarRight}>
          {onSave && (
            <button
              className={`${styles.tbBtn} ${styles.tbBtnPrimary}`}
              onClick={() => void handleSave()}
              title="保存 Ctrl+S"
            >
              <Save size={14} />
              <span>保存</span>
            </button>
          )}
          {rightExtra}
          <div className={styles.tbSep} />
          <button
            className={styles.tbBtnIcon}
            onClick={toggleFullscreen}
            title={isFullscreen ? "缩回窗口" : "放大到真全屏"}
          >
            {isFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button
            className={`${styles.tbBtnIcon} ${styles.tbBtnClose}`}
            onClick={guardedClose}
            title="关闭 Esc"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {/* 主体内容区 */}
      {children}

      {/* 状态栏：两侧都没内容时不渲染 —— rich / diagram 不传状态栏节点，
          无条件渲染会在它们底部凭空多出一条 28px 的空蓝条（.statusBar 有固定高度与渐变底）。 */}
      {(statusLeft || statusRight) && (
        <div className={styles.statusBar}>
          <div className={styles.statusLeft}>{statusLeft}</div>
          <div className={styles.statusRight}>{statusRight}</div>
        </div>
      )}

      {/* 关闭守卫确认框。
          ❗ 两个按钮的语义必须是「关掉」与「别关」，不能都通向关窗：
          ConfirmDialog 把 onCancel 同时绑在遮罩点击 / 标题栏 ✕ / 取消按钮（还带 autoFocus）三处，
          若 onCancel 也执行 onClose，用户点遮罩、点 ✕、直接回车都会丢弃编辑，
          守卫等于没有出路——正是它本来要防的「编辑静默丢失」。
          保存入口由工具栏「保存」按钮和 Ctrl+S 承担，不放进这个二选一里。 */}
      {showConfirmClose && (
        <ConfirmDialog
          open={showConfirmClose}
          title="有未保存的修改"
          message="关闭后本次编辑将丢弃，确定关闭吗？"
          confirmText="不保存关闭"
          cancelText="继续编辑"
          variant="danger"
          onConfirm={handleConfirmClose}
          onCancel={() => setShowConfirmClose(false)}
        />
      )}
    </div>
  );
}
