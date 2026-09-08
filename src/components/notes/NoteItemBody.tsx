/**
 * 笔记的标题 / 摘要 / 元信息三段——列表行与网格卡片**共用**这一份。
 *
 * 为何单抽（规则 #11）：网格形态上来后这段标记有了第二个消费者。
 * 写两份的后果很具体：搜索高亮、AI 摘要回退、标签数上限、字数条、
 * 置顶徽标这五件事要在两个地方各维护一遍，而它们都是改过多轮的（B1/B3/A1）。
 *
 * 🔴 红线：无 AI（`note.summary` 是读已有字段，不发请求）。
 */
import { Pin } from "lucide-react";
import { TagBadge, TagBadgeMore } from "@/components/TagBadge";
import { relativeTime, countChars, fmtCount } from "@/lib/utils";
import { excerpt, excerptAround, highlight } from "@/lib/notes/excerpt";
import type { Note } from "@/lib/api";
import styles from "../KnowledgeView.module.css";

/** 行/卡片内最多摆几个标签，剩下的收成 `+N`。
 *
 * 不摆全部：`.rowMeta` 是 flex-wrap，8 个标签会把一行撞成三行，
 * 而行高不齐是扫列表时最费力的一件事。完整标签在第三栏里看。
 * 取 3 而不是 TagRow 的 2：笔记行比卡片宽，而且标签在知识库里是主要分类手段。 */
export const MAX_ROW_TAGS = 3;

export function NoteItemBody({
  note,
  keyword,
  showFolderColumn,
  folderName,
  onTagClick,
  /** 网格卡片里摘要可以多摆几行（列表行只有一行的高度）。 */
  excerptLines,
}: {
  note: Note;
  keyword: string;
  showFolderColumn: boolean;
  folderName: (id: string | null) => string;
  onTagClick: (tagId: string) => void;
  excerptLines?: number;
}) {
  const chars = countChars(note.content.trim());
  return (
    <>
      <span className={styles.rowTitle}>
        {/* 置顶徽标（B1）。摆在标题前而不是行尾：扫列表时眼睛走的是左边缘，
            而「这条被我置顶了」是一眼就要看到的事。 */}
        {note.pinned && <Pin size={10} className={styles.rowPin} aria-label="已置顶" />}
        {highlight(note.title, keyword)}
      </span>
      {/* 有 AI 摘要就用它，没有才回退到正文截断（B1 轻量 AI）。
          扫列表时一行摘要比一段截断的正文有用得多。
          注意用 `note.summary ||` 而不是 `??`：空串（用户清掉过）也该回退。

          搜索时（B3）摆正文而不是摘要：命中在正文里，而 AI 摘要里未必有那个词——
          继续摆摘要就会出现「搜到了但一个高亮也看不到」。 */}
      <span
        className={styles.rowExcerpt}
        /* 行数靠变量而不是两个类：`-webkit-line-clamp` 只有这一个数字不同。 */
        style={excerptLines ? { WebkitLineClamp: excerptLines } : undefined}
      >
        {keyword.trim()
          ? highlight(excerptAround(note.content, keyword), keyword)
          : note.summary || excerpt(note.content)}
      </span>
      <span className={styles.rowMeta}>
        <span className={styles.rowTime}>{relativeTime(note.updated_at)}</span>
        {/* 字数条（抄卡片的 `.cardSizeTag`）。卡片那边摆的是字节大小，
            笔记里该看的是**字数**——它回答的是「这条我得读多久」。
            空正文不摆：新建未写的笔记挂个「0 字」只是噪声。
            计数走公共 `countChars`（按码点数，emoji 算 1 个），不用 `.length`。 */}
        {chars > 0 && <span className={styles.rowSize}>{fmtCount(chars)} 字</span>}
        {/* 标签走全应用**唯一**的 TagBadge（规则 #11 公共函数收口）。
            A1：行内标签可点 = 切换该标签的筛选。
            ❗ 接的是知识库自己的 `tagIds`，**不是** `TagRow` 那个 `toggleTagFilter`
              （那是记录模式的筛选器，在这里点下去会去筛剪贴板卡片）。
              TagBadge 内部已经 `stopPropagation` + `preventDefault`，
              所以不会连带触发行/卡片的「打开笔记」。 */}
        {note.tags.slice(0, MAX_ROW_TAGS).map((tag) => (
          <TagBadge
            key={tag.id}
            tag={tag}
            /* ❗ 不传 `active`：`TagBadge` 的 `active` 只对 `picker` 变体生效（看它的实现），
               行内用的是 `card` 变体。传一个不生效的 prop 比不传更容易骗人。 */
            onClick={() => onTagClick(tag.id)}
          />
        ))}
        {note.tags.length > MAX_ROW_TAGS && (
          <TagBadgeMore count={note.tags.length - MAX_ROW_TAGS} />
        )}
        {/* 侧栏收起时才显所属文件夹：展开时树里已经高亮着了，重复信息 */}
        {showFolderColumn && (
          <span className={styles.rowFolder}>{folderName(note.folder_id)}</span>
        )}
      </span>
    </>
  );
}
