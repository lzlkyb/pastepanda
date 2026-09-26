/**
 * FullscreenShell —— 全屏编辑器的「通用外壳」复用层。
 *
 * 背景：rich / diagram / diff 三类不走 CodeMirror 单栏机制（CodeDocument），
 * 之前各自平行重写工具栏 / 主题判定 / 全屏切换 / 关闭守卫 / 状态栏，
 * 导致与 single 类观感一致但代码重复、且主题判定硬编码 midnight||ocean-dark
 * （加主题必漏判）。本壳把这些「外壳能力」收敛到一处。
 *
 * 多标签改造后本壳新增两类能力：
 *   ① `topExtra` 插槽 —— 标签栏要落在「工具栏之下、内容之上」，与 CodeDocument
 *      的 tabBar 位置一致（设计稿定的位置；挂进各类型自己重画会让位置随类型漂移）。
 *   ② 窗口级能力（主题 / 全屏 / 关闭请求）**可外部注入**：宿主接管时传 props，
 *      不传则维持原来的自管行为（单文档场景与测试仍可直接用）。
 *      ❗ 这不是「两套实现并存」，而是同一套逻辑的两种接线：宿主接管时会跳过
 *      自管分支（见 darkMode === undefined 判断），不会出现两份状态打架。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Save, X, Maximize2, Minimize2, Minus } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DEFAULT_THEME, isDarkTheme } from "@/lib/theme";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SkinScene } from "@/components/SkinScene";
import { logger } from "@/lib/logger";
import type { TabMeta } from "@/lib/editorTabs";
import styles from "./FullscreenEditor.module.css";

/**
 * 三类「非 CodeMirror」文档视图（rich / diagram / diff）共用的宿主槽位。
 * 由 `EditorDocument` 统一注入，各类型原样透传给 FullscreenShell。
 */
export interface DocumentViewSlots {
  /** 顶部插槽（标签栏），插在工具栏之后 */
  topExtra?: ReactNode;
  /** 本视图是否为当前活动标签（非活动时不响应窗口级快捷键） */
  active?: boolean;
  /** 主题明暗；不传则壳自己读 */
  darkMode?: boolean;
  /** 全屏态；不传则壳自己同步 */
  isFullscreen?: boolean;
  onFullscreenToggle?: () => void;
  onMinimize?: () => void;
  /** 关闭请求；传了则 ✕/Esc 直通宿主（守卫上提），不传则壳内自带脏守卫 */
  onRequestClose?: () => void;
  /** 元信息上报（宿主标签栏渲染用） */
  onMeta?: (meta: TabMeta) => void;
  /** 注册「关闭前保存」（宿主多标签守卫逐项调用用） */
  registerSave?: (fn: (() => Promise<boolean>) | null) => void;
}

export interface FullscreenShellProps extends DocumentViewSlots {
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
  topExtra,
  active = true,
  darkMode,
  isFullscreen,
  onFullscreenToggle,
  onMinimize,
  onRequestClose,
  onMeta,
  registerSave,
}: FullscreenShellProps) {
  const [ownDark, setOwnDark] = useState(false);
  const [showConfirmClose, setShowConfirmClose] = useState(false);
  // dirty 由调用方通过 prop 实时传入；直接用最新值即可（无需 ref 桥接）
  const isDirty = dirty;

  const metaRef = useRef(onMeta);
  metaRef.current = onMeta;
  const registerRef = useRef(registerSave);
  registerRef.current = registerSave;

  // 主题判定：统一走 isDarkTheme（theme.ts 收口），灭掉各类型硬编码 midnight||ocean-dark。
  // 宿主接管（darkMode 有值）时整段跳过 —— 不挂重复的窗口级监听（规则 8.2）。
  useEffect(() => {
    if (darkMode !== undefined) return;
    const applyTheme = (theme: string) => setOwnDark(isDarkTheme(theme || DEFAULT_THEME));
    invoke<{ theme?: string }>("get_config")
      .then((cfg) => applyTheme(cfg.theme ?? DEFAULT_THEME))
      .catch(() => { /* 读不到就保持默认亮色 */ });
    // 运行时主题切换也跟随（独立窗口拿不到主窗口 store，只能监听事件）
    const unsubPromise = listen<{ theme?: string }>("theme-changed", (e) =>
      applyTheme(e.payload?.theme ?? DEFAULT_THEME));
    return () => { void unsubPromise.then((u) => u()); };
  }, [darkMode]);

  const [ownIsFullscreen, setOwnIsFullscreen] = useState(false);
  useEffect(() => {
    if (isFullscreen !== undefined) return;
    const win = getCurrentWindow();
    let disposed = false;
    let unlistenResize: (() => void) | undefined;
    win.isFullscreen().then((fs) => { if (!disposed) setOwnIsFullscreen(fs); }).catch(() => {});
    win.onResized(() => {
      win.isFullscreen().then((fs) => { if (!disposed) setOwnIsFullscreen(fs); }).catch(() => {});
    }).then((fn) => { if (disposed) fn(); else unlistenResize = fn; });
    return () => { disposed = true; unlistenResize?.(); };
  }, [isFullscreen]);

  const fullscreenOn = isFullscreen ?? ownIsFullscreen;
  const darkOn = darkMode ?? ownDark;

  const doToggleFullscreen = useCallback(async () => {
    if (onFullscreenToggle) {
      onFullscreenToggle();
      return;
    }
    try {
      const win = getCurrentWindow();
      const next = !(await win.isFullscreen());
      await win.setFullscreen(next);
      setOwnIsFullscreen(next);
    } catch (e) {
      logger.error("切换全屏失败", e);
    }
  }, [onFullscreenToggle]);

  const handleSave = useCallback(async (): Promise<boolean> => {
    if (!onSave) return false;
    try {
      const r = await onSave();
      return r !== false;
    } catch {
      return false;
    }
  }, [onSave]);

  // 关闭守卫：脏 → 先确认；否则直接关。
  // 宿主接管（onRequestClose）时直通 —— 多标签下守卫必须由宿主统一裁决，
  // 否则关窗时每个脏标签各弹一个框，既不告知总数也无法一次处置。
  const guardedClose = useCallback(() => {
    if (onRequestClose) {
      onRequestClose();
      return;
    }
    if (isDirty) {
      setShowConfirmClose(true);
      return;
    }
    onClose();
  }, [onRequestClose, isDirty, onClose]);

  const handleConfirmClose = useCallback(() => {
    setShowConfirmClose(false);
    onClose();
  }, [onClose]);

  // 快捷键：Ctrl+S 保存（有 onSave）/ Esc 关闭守卫。
  // active === false（非活动标签）时不响应 —— 否则按一次 Esc，N 个标签各弹一遍。
  useEffect(() => {
    if (!active) return;
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
  }, [active, onSave, handleSave, guardedClose]);

  // 上行：元信息（标签栏）+ 关闭前保存注册（宿主多标签守卫）
  useEffect(() => {
    metaRef.current?.({
      fileName: title,
      icon,
      isDirty,
      isSaving: false,
      tabError: false,
      // 有 onSave 才叫「有保存能力」；关闭守卫据此区分
      // 「保存失败」（要拦住关窗）与「本来就没得存」（不该拦）
      canSave: !!onSave,
      focusMode: false,
    });
  }, [title, icon, isDirty, onSave]);

  const saveForClose = useMemo(() => () => handleSave(), [handleSave]);
  /**
   * 注册「关闭前保存」（宿主的多标签守卫逐项调用）。
   *
   * ❗ 没有保存能力时**必须不注册**：`handleSave` 在 `!onSave` 时恒返回 false，
   * 注册出去等于告诉宿主「我有保存能力、但这次写盘失败了」——宿主的 saveAll 会据此
   * 拒绝关闭，而这个文档根本无处可存。diff 全屏（可改文本、无落盘目标、工具栏无保存按钮）
   * 正是这么被卡死的：点「保存并关闭」永远报「有文档未能保存」。
   *
   * 不注册之后，宿主按「没有 handler」跳过它 ⇒ 直接关，这才是真实语义。
   */
  useEffect(() => {
    if (!onSave) return;
    registerRef.current?.(() => saveForClose());
    return () => registerRef.current?.(null);
  }, [onSave, saveForClose]);

  return (
    <div className={styles.overlay} data-theme-mode={darkOn ? "dark" : "light"}>
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
          {onMinimize && (
            /* ui-rule-ok: 窗口控制三连（— / ⤢ / ✕）里的最小化，与 × 同属通用符号 */
            <button className={styles.tbBtnIcon} onClick={onMinimize} title="最小化">
              <Minus size={15} />
            </button>
          )}
          <button
            className={`${styles.tbBtnIcon} ${fullscreenOn ? styles.tbBtnActive : ""}`}
            onClick={() => void doToggleFullscreen()}
            title={fullscreenOn ? "缩回窗口" : "放大到真全屏"}
          >
            {fullscreenOn ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
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

      {/* 标签栏插槽（宿主注入，只给活动标签） */}
      {topExtra}

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

      {/* 关闭守卫确认框（仅「壳自管」路径；宿主接管时三步走由 CloseAllDialog 负责）。
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
