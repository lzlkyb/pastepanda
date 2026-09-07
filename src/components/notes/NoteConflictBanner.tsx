/**
 * NoteConflictBanner.tsx —— 打开一份冲突副本时顶部那条入口（W4a）。
 *
 * 单独成件而不往 `NoteConflictView` 里堆：两个宿主
 * （`NoteDetailPane` 与 `NoteDialog`）都要用它，而那个文件已经顶到 300 行（规则 #7）。
 *
 * 为何入口在这里而不是设置页：AM-6 —— 输出要去它被用的地方。
 * 用户是从状态条搜到这篇副本、点开它的；对照入口就得在这一眼里。
 */

/** 正文里有冲突标记时渲染。`onOpen` 把宿主切到对照视图。 */
export function NoteConflictBanner({ onOpen }: { onOpen: () => void }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 12px",
        fontSize: 12,
        background: "var(--orange-bg)",
        color: "var(--orange)",
        borderBottom: "1px solid var(--border-color)",
      }}
    >
      <span style={{ flex: 1 }}>
        这是一份<b>冲突副本</b> —— 两台设备在同一段时间里各改了同一篇。
      </span>
      <button
        type="button"
        onClick={onOpen}
        style={{
          border: "none",
          background: "transparent",
          padding: 0,
          cursor: "pointer",
          color: "var(--accent-strong)",
          fontSize: 12,
          textDecoration: "underline",
          whiteSpace: "nowrap",
        }}
      >
        与原笔记对照 →
      </button>
    </div>
  );
}
