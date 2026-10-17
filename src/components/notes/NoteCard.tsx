/**
 * 网格形态的单张卡片。与 `NoteRow` 平行：列表的全部逻辑
 *（选中集 / roving tabindex / 键盘 / 拖拽 / 分组 / 加载更多）仍在 `NoteList`，
 * 这里只管一张卡片长什么样。
 *
 * 🔴 红线：无 AI。
 */
import { useMemo, useState } from "react";
import { FolderInput, MoreHorizontal, Pin, PinOff } from "lucide-react";
import type { MenuItem } from "@/components/ContextMenu";
import type { Note } from "@/lib/api";
import { coverUrlOf, coverStepOf, coverInitialOf } from "@/lib/notes/cover";
import { noteIconColor } from "@/lib/contentTypes";
import { NoteItemBody } from "./NoteItemBody";
import { NOTE_DRAG_MIME } from "@/lib/notes/dragMime";
import styles from "../KnowledgeView.module.css";

/** 网格里摘要摆几行。卡片比行高，一行太浪费。 */
const GRID_EXCERPT_LINES = 2;

export function NoteCard({
  note,
  index,
  active,
  selected,
  anySelected,
  selectedIds,
  onRowSelect,
  keyword,
  onTagClick,
  focused,
  rowRef,
  showFolderColumn,
  folderName,
  buildMenu,
  folderMenu,
  ctxTrigger,
  onOpen,
  onTogglePin,
  onFocusRow,
}: {
  note: Note;
  index: number;
  active: boolean;
  selected: boolean;
  anySelected: boolean;
  selectedIds: Set<string>;
  onRowSelect: (index: number, mode: "toggle" | "range") => void;
  keyword: string;
  onTagClick: (tagId: string) => void;
  focused: boolean;
  rowRef: (el: HTMLButtonElement | null) => void;
  showFolderColumn: boolean;
  folderName: (id: string | null) => string;
  buildMenu: (note: Note) => MenuItem[];
  folderMenu: (note: Note) => MenuItem[];
  ctxTrigger: ((x: number, y: number, items: MenuItem[]) => void) | null;
  onOpen: (note: Note) => void;
  onTogglePin: (note: Note) => void;
  /** 把键盘焦点索引挂到本卡片（动作条按下时调）。理由见 `NoteList` 的 `focusRow`。 */
  onFocusRow: (index: number) => void;
}) {
  // ❗ useMemo 不是乐观优化：本组件没 `React.memo`，`NoteList` 一重渲染（比如
  //   每按一次方向键改变 `focusIdx`）全部卡片都重渲染，而 `coverUrlOf` 对没图的
  //   笔记要扫完全文。详细缘由看 `NoteRowIcon` 里同位置的注释。
  const cover = useMemo(() => coverUrlOf(note.content), [note.content]);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showCover = cover !== null && cover !== failedSrc;

  return (
    // 不做逐卡入场或 layout 测量；列表/网格共用稳定的原位反馈。
    <li
      className={`${styles.card}${active ? ` ${styles.rowActive}` : ""}${
        selected ? ` ${styles.rowSelected}` : ""
      }`}
      onContextMenu={(e) => {
        if (!ctxTrigger) return;
        e.preventDefault();
        ctxTrigger(e.clientX, e.clientY, buildMenu(note));
      }}
    >
      {anySelected && (
        <span
          className={`${styles.cardCheck} ${selected ? styles.rowCheckOn : ""}`}
          aria-hidden="true"
        />
      )}

      {/* 悬停动作条：与列表行共用同一套类（`.rowActs` / `.rowActBtn`）。
          `onMouseDown` 同行那边：先对齐键盘焦点索引，否则之后按 P/M 会动到另一张卡。 */}
      <span className={styles.rowActs} onMouseDown={() => onFocusRow(index)}>
        <button
          type="button"
          className={`${styles.rowActBtn} ${note.pinned ? styles.rowActBtnOn : ""}`}
          title={note.pinned ? "取消置顶（P）" : "置顶（P）"}
          aria-label={note.pinned ? `取消置顶 ${note.title}` : `置顶 ${note.title}`}
          tabIndex={-1}
          onClick={() => onTogglePin(note)}
        >
          {note.pinned ? <PinOff size={14} /> : <Pin size={14} />}
        </button>
        <button
          type="button"
          className={styles.rowActBtn}
          title="移动到文件夹（M）"
          aria-label={`移动 ${note.title} 到文件夹`}
          tabIndex={-1}
          onClick={(e) => {
            const items = folderMenu(note);
            if (!ctxTrigger || items.length === 0) return;
            const r = e.currentTarget.getBoundingClientRect();
            ctxTrigger(r.left, r.bottom + 2, items);
          }}
        >
          <FolderInput size={14} />
        </button>
        <button
          type="button"
          className={styles.rowActBtn}
          title="更多"
          aria-label={`${note.title} 的更多操作`}
          tabIndex={-1}
          onClick={(e) => {
            if (!ctxTrigger) return;
            const r = e.currentTarget.getBoundingClientRect();
            ctxTrigger(r.left, r.bottom + 2, buildMenu(note));
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      </span>

      <button
        type="button"
        className={styles.cardMain}
        ref={rowRef}
        /* 本卡的色调，与列表行一样挂在整张卡上。
           ❗ 封面上那个 `--kb-cover-tint` 代替不了它：它只在封面那个
           `<span>` 上，而 `NoteItemBody`（字数条就在里面）是它的**兄弟**，
           继承不到；而且有真封面图时那个分支根本不渲染。
           少了这行，同一篇笔记的字数条在列表里带色、在网格里是灰的。 */
        style={{ ["--kb-row-tint" as string]: noteIconColor(note) }}
        tabIndex={focused ? 0 : -1}
        draggable
        onDragStart={(e) => {
          const ids = selected ? [...selectedIds] : [note.id];
          e.dataTransfer.setData(NOTE_DRAG_MIME, JSON.stringify(ids));
          e.dataTransfer.effectAllowed = "move";
        }}
        onClick={(e) => {
          if (e.ctrlKey || e.metaKey) {
            onRowSelect(index, "toggle");
          } else if (e.shiftKey) {
            onRowSelect(index, "range");
          } else {
            onOpen(note);
          }
        }}
      >
        {/* 封面区。有图用真图，没图用**文字封面**（设计稿 §4 候选甲）。

            🔴 不能「无图就不留封面位」：Grid 默认 `align-items: stretch`，
              同一行里无封面卡会被拉到和有封面卡等高，正文下方留一大片空白；
              改 `align-items: start` 则行与行错位，看着像布局坏了。
              留位 + 文字封面是唯一既等高又不空的做法。 */}
        {showCover ? (
          <span className={styles.cardCover}>
            <img
              src={cover}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setFailedSrc(cover)}
            />
          </span>
        ) : (
          <span
            className={styles.cardCoverTxt}
            /* 深浅档由 `note.id` 哈希定（稳定）；色相走 `--kb-cover-tint`，
               与列表行图标的 `--kb-icon-tint` **同一个取色函数**（规则 #11）：
               同一篇笔记在列表与网格里必须是同一个颜色，否则切一下形态整屏换色。
               仍然在 CSS 里用 `color-mix` 掺进 `--section-bg`，没改混合比例——
               那里那段红色注释要求的正是这个。 */
            style={{
              ["--kb-cover-step" as string]: String(coverStepOf(note.id)),
              ["--kb-cover-tint" as string]: noteIconColor(note),
            }}
            aria-hidden="true"
          >
            {coverInitialOf(note.title)}
          </span>
        )}

        <span className={styles.cardBody}>
          <NoteItemBody
            note={note}
            keyword={keyword}
            showFolderColumn={showFolderColumn}
            folderName={folderName}
            onTagClick={onTagClick}
            excerptLines={GRID_EXCERPT_LINES}
          />
        </span>
      </button>
    </li>
  );
}
