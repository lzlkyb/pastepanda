/**
 * 全屏编辑器工具栏（纯展示）
 *
 * 从 `FullscreenEditor.tsx` 抽出。这里只负责「按给定的可见性条件渲染」，
 * **不持有任何状态**——视图模式、大纲开关、文件路径、全屏态统统由宿主传入；
 * 点击回调也由宿主提供。（唯一例外：⋯ 菜单的开合是 DropdownMenu 的内部状态。）
 *
 * 稿子 P0-4 收束：右侧最多 9 个元素 → 5 元素
 *   保存（主按钮）｜视图分段｜大纲（md 专属）｜⋯｜关闭
 * 重载 / 打开文件 / 真全屏是低频操作，收进 ⋯ 菜单（浮层卡 --float-card-*）。
 *
 * ⚠️ 两个「不适用就不出现」的取舍是本项目刻意的：
 *    - 重载仅在文件模式出现在 ⋯ 菜单里（剪贴板内容没有磁盘文件）；
 *    - 大纲只对 markdown 渲染。
 *    摆一个点了没反应的按钮比不摆更坏，不要在宿主里传「禁用态」进来。
 */
import { ListTree, Save, X, Ellipsis, Crosshair, RotateCw, FolderOpen, Maximize2, Minimize2, Minus } from "lucide-react";
import { LanguagePicker } from "./LanguagePicker";
import { DropdownMenu, type MenuEntry } from "./DropdownMenu";
import type { SpecMode, ViewMode } from "./types";
import styles from "../FullscreenEditor.module.css";

interface EditorToolbarProps {
  /** 类型图标字符（md / {} / </> …） */
  icon: string;
  /** 显示用文件名（不含目录） */
  fileName: string;
  /** 磁盘路径；为 null 表示剪贴板内容模式（⋯ 菜单里无重载项） */
  currentFilePath: string | null;
  /** 有未保存改动时显示小圆点 */
  isDirty: boolean;
  /** 写盘进行中：保存按钮转「… 保存中」并禁用（防抖等待期不算，宿主裁决） */
  isSaving: boolean;

  /** 动态语言（code 类型）才渲染语言选择器 */
  dynamicLanguage: boolean;
  languageName: string | null;
  onLanguageChange: (name: string | null) => void;

  /** 视图模式分段控件；长度 ≤ 1 时整组连同分隔符都不渲染 */
  modes: SpecMode[];
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;

  /** markdown 才渲染大纲按钮 */
  showOutlineButton: boolean;
  showOutline: boolean;
  onToggleOutline: () => void;

  isFullscreen: boolean;
  onFullscreenToggle: () => void;
  /** 最小化到任务栏（用户实际使用高频：窗口平时最小化放着，回来要一键放大） */
  onMinimize: () => void;

  onReload: () => void;
  onOpen: () => void;
  onSave: () => void;
  onClose: () => void;
  /** ⋯ 菜单首项：专注模式（P1-3；快捷键 Ctrl+Shift+F 在外壳的键盘 effect） */
  onFocusMode: () => void;
}

export function EditorToolbar({
  icon,
  fileName,
  currentFilePath,
  isDirty,
  isSaving,
  dynamicLanguage,
  languageName,
  onLanguageChange,
  modes,
  viewMode,
  onViewModeChange,
  showOutlineButton,
  showOutline,
  onToggleOutline,
  isFullscreen,
  onFullscreenToggle,
  onMinimize,
  onReload,
  onOpen,
  onSave,
  onClose,
  onFocusMode,
}: EditorToolbarProps) {
  // ⋯ 菜单条目：专注模式 / 重载 / 打开文件。
  // 重载仅文件模式出现（不适用就不出现）。
  // 全屏切换**不在菜单里**：用户反馈「缩小/放大是高频操作」（窗口平时最小化放着），
  // 稿子 P0-4「全屏按钮几乎没点过」的假设被真实使用习惯推翻 —— 回归常驻按钮。
  const moreEntries: MenuEntry[] = [
    {
      key: "focus",
      label: "专注模式",
      icon: <Crosshair size={14} />,
      kbd: "Ctrl+Shift+F",
      onSelect: onFocusMode,
    },
    "sep",
    ...(currentFilePath
      ? [
          {
            key: "reload",
            label: "从磁盘重新加载",
            icon: <RotateCw size={14} />,
            title: "文件在外部被修改过时用",
            onSelect: onReload,
          },
        ]
      : []),
    {
      key: "open",
      label: "打开文件…",
      icon: <FolderOpen size={14} />,
      onSelect: onOpen,
    },
  ];

  return (
    <div className={styles.toolbar} data-tauri-drag-region="deep">
      <div className={styles.toolbarLeft}>
        <div className={styles.fileIcon}>{icon}</div>
        {/* 方案C：同行拼接（与真实代码一致，工具栏保持 48px）。
            脏点用 .fileName + .unsavedDot 直接相邻 —— 反馈与所属同域：
            原先脏点在路径之后，路径长时它会被推到很右边，跟文件名脱开。 */}
        <span className={styles.fileName}>{fileName}</span>
        {isDirty && <div className={styles.unsavedDot} />}
        {currentFilePath && (
          <span className={styles.filePath}>
            — {currentFilePath.replace(/[\\/][^\\/]+$/, "")}
          </span>
        )}
        {dynamicLanguage && <LanguagePicker value={languageName} onChange={onLanguageChange} />}
      </div>

      <div className={styles.toolbarRight}>
        {/* 写盘中禁用并转「… 保存中」——防抖等待期不进这里（isSaving 只在真正写盘段为 true） */}
        <button
          className={`${styles.tbBtn} ${styles.tbBtnPrimary}`}
          onClick={onSave}
          disabled={isSaving}
          title={isSaving ? "正在保存" : "保存 Ctrl+S"}
        >
          <Save size={14} />
          <span>{isSaving ? "… 保存中" : "保存"}</span>
        </button>

        {/* 视图分段控件（P0-1）：图标 + 常驻文字，容器 --seg-bg、激活 --seg-active-bg */}
        {modes.length > 1 && (
          <>
            <div className={styles.tbSep} />
            <div className={styles.viewSeg} role="group" aria-label="视图模式">
              {modes.map(({ key, title, label, Icon }) => (
                <button
                  key={key}
                  type="button"
                  className={`${styles.viewSegBtn} ${viewMode === key ? styles.viewSegBtnOn : ""}`}
                  onClick={() => onViewModeChange(key)}
                  title={title}
                  aria-pressed={viewMode === key}
                >
                  <Icon size={13} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {/* 大纲：只对 markdown 有意义（其它类型没有 # 标题结构）。 */}
        {showOutlineButton && (
          <button
            className={`${styles.tbBtnIcon} ${showOutline ? styles.tbBtnActive : ""}`}
            onClick={onToggleOutline}
            title="大纲（按标题跳转）"
          >
            <ListTree size={15} />
          </button>
        )}

        {/* ⋯ 在最小化前面（用户调整：低频菜单靠内容侧，窗口控制钮靠角落） */}
        <DropdownMenu
          trigger={<Ellipsis size={16} />}
          triggerClassName={styles.tbBtnIcon}
          triggerTitle="更多操作"
          entries={moreEntries}
          align="right"
        />

        {/* 最小化 + 全屏切换常驻（用户拍板方案 B：高频操作不收进 ⋯） */}
        <button className={styles.tbBtnIcon} onClick={onMinimize} title="最小化">
          <Minus size={15} />
        </button>
        <button
          className={`${styles.tbBtnIcon} ${isFullscreen ? styles.tbBtnActive : ""}`}
          onClick={onFullscreenToggle}
          title={isFullscreen ? "缩回窗口" : "放大到真全屏"}
        >
          {isFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>

        <button className={`${styles.tbBtnIcon} ${styles.tbBtnClose}`} onClick={onClose} title="关闭 Esc">
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
