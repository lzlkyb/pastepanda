/**
 * 全屏编辑器状态栏（纯展示）
 *
 * 从 `FullscreenEditor.tsx` 抽出，理由同上（那个文件过千行）。
 *
 * ⚠️ 这里承载的是「规则 15」要求与触发同域可见的反馈：
 *    保存触发在工具栏（常驻可见），所以保存状态必须也在常驻可见的状态栏里
 *    （`.statusRight` 设了 `flex-shrink: 0`，窄窗压下左侧字数统计也不压它）。
 *
 * 保存态是**互斥的四种语义**，升级为带色徽章（2026-09 工作台化 P0-3）：
 *      - `autoSaveError` 「存不进去」——不会自己好，必须提醒手动重试；
 *      - `isSaving`      「正在写盘」——转瞬即过的过渡态（防抖等待不算，那还是未保存）；
 *      - `isDirty`       「还没存」——防抖期内会自己好；
 *      - 其余            「已保存」。
 * 把后两态并进前两态是本文件要防的主要回归（终点是丢稿）。
 *
 * B4（光标定位）：`cursor` 由宿主从 CodeMirror 选区更新推送；仅编辑/分屏模式
 * 有值（仅预览没有光标这回事），为 null 时不渲染，不留占位。
 */
import styles from "../FullscreenEditor.module.css";

/** CodeMirror 光标状态（B4）。col 从 1 计；selLen 为选中字符数（0 = 无选区）。 */
export interface CursorInfo {
  line: number;
  col: number;
  selLen: number;
}

interface EditorStatusBarProps {
  lines: number;
  words: number;
  /** 0 表示不足 1 分钟（或空文档），此时不显示该字段 */
  readMin: number;

  isDirty: boolean;
  isSaving: boolean;
  autoSaveError: boolean;
  /** 状态栏类型标签（纯文本 / Markdown / JSON …） */
  typeLabel: string;

  /** B4 光标定位；null（仅预览/非 CodeMirror 类型）不渲染 */
  cursor: CursorInfo | null;
  /** 自动保存失败时点徽章重试（= Ctrl+S 同源回调）；不传则失败态不可点 */
  onSaveRetry?: () => void;
}

/** 保存态徽章（P0-3 四态）。状态栏与专注模式的右上角常驻钉（FocusChrome）共用同一份映射。 */
export function SaveBadge({
  isDirty,
  isSaving,
  autoSaveError,
  onRetry,
}: {
  isDirty: boolean;
  isSaving: boolean;
  autoSaveError: boolean;
  /** 稿子细节：失败态点按可重试（= Ctrl+S）。只有失败态可点，其余态渲染纯展示 span。 */
  onRetry?: () => void;
}) {
  // 保持「失败 > 保存中 > 脏 > 已保存」的判定顺序：失败态即使同时 isDirty 也必须报失败；
  // 保存中（写盘段）用户又打了字的话，写盘完成前先报「保存中」，落回什么由写盘结果决定。
  const badge = autoSaveError
    ? {
        text: "自动保存失败 · Ctrl+S 重试",
        cls: styles.saveBadgeFailed,
        title: "自动保存写盘失败，改动还在编辑器里。点击本徽章或按 Ctrl+S 重试，或另存为其他路径",
      }
    : isSaving
      ? { text: "保存中…", cls: styles.saveBadgeSaving, title: "正在写入磁盘" }
      : isDirty
        ? { text: "未保存", cls: styles.saveBadgeDirty, title: "改动尚未写入磁盘" }
        : { text: "已保存", cls: styles.saveBadgeSaved, title: "与磁盘一致" };

  const content = (
    <>
      <span className={styles.saveBadgeDot} />
      {badge.text}
    </>
  );

  if (autoSaveError && onRetry) {
    return (
      <button
        type="button"
        className={`${styles.saveBadge} ${styles.saveBadgeAsBtn} ${badge.cls}`}
        title={badge.title}
        onClick={onRetry}
      >
        {content}
      </button>
    );
  }
  return (
    <span className={`${styles.saveBadge} ${badge.cls}`} title={badge.title}>
      {content}
    </span>
  );
}

export function EditorStatusBar({
  lines,
  words,
  readMin,
  isDirty,
  isSaving,
  autoSaveError,
  typeLabel,
  cursor,
  onSaveRetry,
}: EditorStatusBarProps) {
  return (
    <div className={styles.statusBar}>
      <div className={styles.statusLeft}>
        {/* P0-6：文件名与字符数**不再重复显示** —— 文件名在工具栏已有，
            字符数与「字数」是同一信息的两种口径，留对写作更有用的那个。
            保留：行数 / 字数 / 阅读时长 / 编码。 */}
        <span className={styles.statusItem}>{lines} 行</span>
        <span className={styles.statusItem}>{words} 字</span>
        {readMin > 0 && (
          <span className={styles.statusItem} title="按 300 字/分钟估算">
            约 {readMin} 分钟读完
          </span>
        )}
        <span className={styles.statusItem}>UTF-8</span>
      </div>

      <div className={styles.statusRight}>
        {/* B4 光标定位（等宽数字防跳动）。有选区时追加「已选 N 字」，
            稿子 mock 两项并存：定位常驻，选区是瞬时状态。 */}
        {cursor && (
          <>
            <span className={`${styles.statusItem} ${styles.statusMono}`}>
              行 {cursor.line}，列 {cursor.col}
            </span>
            {cursor.selLen > 0 && (
              <span className={`${styles.statusItem} ${styles.statusMono}`}>
                已选 {cursor.selLen} 字
              </span>
            )}
          </>
        )}
        <SaveBadge
          isDirty={isDirty}
          isSaving={isSaving}
          autoSaveError={autoSaveError}
          onRetry={onSaveRetry}
        />
        <span className={styles.statusItem}>{typeLabel}</span>
      </div>
    </div>
  );
}
