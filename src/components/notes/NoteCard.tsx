/**
 * 网格形态的单张卡片。与 `NoteRow` 平行：列表的全部逻辑
 *（选中集 / roving tabindex / 键盘 / 拖拽 / 分组 / 加载更多）仍在 `NoteList`，
 * 这里只管一张卡片长什么样。
 *
 * 🔴 红线：无 AI。
 */
import { useMemo, useState } from "react";
import { motion } from "framer-motion";
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
    // ❗ 故意不挂 framer 的 `layout`，理由有三条，任一条都够：
    // ① 它做不出列表↔网格的切换动画。切换时同一个 key 上的组件类型从
    //    `NoteRow` 变成 `NoteCard`，React 是卸载重挂，projection 节点没有
    //    「上一次的测量」可比，framer 直接以新位置出现。
    // ② `layout` 与这里的 `whileHover` scale 互相打架：投影层要为父级 scale
    //    反向补偿子元素，悬停时标题/摘要会轻微变形。`NoteRow` 同样有这个
    //    whileHover，也同样没挂 layout —— 两者保持一致。
    // ③ 挂上就是每次提交都要对全部卡片做一次测量（强制同步布局），
    //    而它唯一真正能出动画的场景只有列数变化，不值这个价。
    // 减少动态效果的降级不需要在这里写：`main.tsx` 已挂 <MotionConfig
    // reducedMotion="user">，位移/缩放整条通道由它统一关掉。
    <motion.li
      className={`${styles.card}${active ? ` ${styles.rowActive}` : ""}${
        selected ? ` ${styles.rowSelected}` : ""
      }`}
      /* 抬升 / 按压参数直接用行那一套（也就是卡片那一套），不另定一套。
         ❗ `whileTap` 一开始漏了，只抄了 `whileHover`——结果是点行有按压反馈、
           点卡片没有，正是上面这句注释声称避开的那种不统一。（2026-09-07 补） */
      whileHover={{ y: -2, scale: 1.01, transition: { type: "spring", stiffness: 500, damping: 30 } }}
      whileTap={{ scale: 0.985, transition: { duration: 0.08, ease: "easeOut" } }}
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
    </motion.li>
  );
}
