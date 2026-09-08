/**
 * 笔记行 / 回收站行的 34px 图标槽：有图就装缩略图，没图装来路图标。
 *
 * 从 `NoteList.tsx` 拆出来的两个理由：
 * ① 那个文件已经 471 行，远超规则 #7 的 300 行，不能再往里堆；
 * ② `provenanceOf` 本来就是两处共用（笔记行 + 回收站），
 *    放在 `NoteList` 里让 `TrashPanel` 反向 import 一个列表组件，
 *    依赖方向本来就是反的。
 *
 * 🔴 红线：无 AI。
 */
import { useMemo, useState } from "react";
import { Bot, CalendarDays, ClipboardList, PenLine, type LucideIcon } from "lucide-react";
import { coverUrlOf } from "@/lib/notes/cover";
import type { Note } from "@/lib/api";

/**
 * 34px 槽里图标的绘制尺寸。
 *
 * 记录模式是 42px 槽配 `size={18}`（`Card.tsx`）；这边槽是 34px，
 * 按同比例取 17。不把槽也抬到 42：中栏在 ≥800px 下是固定 300px
 * （`KnowledgeView.module.css`），多占 8px 会从标题里抠。
 */
const ICON_SIZE = 17;

/**
 * 一篇笔记的「来路」：图标组件 + 悬停解释。
 *
 * 记录模式的卡片图标编的是内容类型（文本/图片/链接/代码……），
 * 而笔记里真正有区分度的是「这条从哪来」——这是知识库独有的维度，
 * 也是 M5 之后才有东西可看的一个维度。
 *
 * 导出的缘由（规则 #11）：回收站需要的正是同一个维度——用户恢复前要判
 * 「这是什么」。在 `TrashPanel` 里再写一份就是两份会分歧的图标表。
 *
 * 返回**组件**而不是现成元素：尺寸的决定权留在调用方。
 * 写成 `<Bot size={17} />` 直接返回的话，将来多一个尺寸不同的槽
 * （比如 24px）就会静默溢出，而那种错没人会注意到。
 *
 * ❗ `notes.source_agent` 的准确含义是「由 AI **新建**」而不是「被 AI 改过」：
 *   `note_update_from` 只把来源写进**版本快照**（W2 的 `note_revisions.source_agent`），
 *   不动 `notes.source_agent`——那两个是不同的事实（创建者 vs 最近改动者）。
 *   所以文案不能写成「AI 改过」，而是指向版本历史。
 */
export function provenanceOf(note: Note): { Icon: LucideIcon; label: string } {
  if (note.source_agent) {
    const name = note.source_agent.replace(/^agent:/, "");
    return { Icon: Bot, label: `由 ${name} 新建。AI 对已有笔记的修改看版本历史。` };
  }
  if (note.daily_date) return { Icon: CalendarDays, label: `今日速记 · ${note.daily_date}` };
  if (note.history_id) return { Icon: ClipboardList, label: "由剪贴板卡片转来" };
  return { Icon: PenLine, label: "手工新建" };
}

/**
 * 图标槽的内容：正文第一张图能解出来就装缩略图，否则装来路图标。
 *
 * 为何要这个：记录模式把真实缩略图直接塞进图标槽（`.cardImgThumb`），
 * 而知识库这个槽以前永远是一个字符——图片笔记与纯文笔记在列表里
 * 长得一模一样。
 *
 * 🔴 失败标记必须是组件内部 state 而不能提到列表层：
 *   路径失效是单行的事，提上去会让一张碎图重渲染整个列表。
 *
 * ❗ 记的是「哪个 src 挂了」而不是一个布尔：后者在用户把图换成另一张
 *   （同一条笔记、cover 变了）之后会一直卡在降级态，新图永远不显。
 */
export function NoteRowIcon({
  note,
  className,
  thumbClassName,
}: {
  note: Note;
  /** 槽本体的类（`.rowIcon` 或 `.trashIcon`） */
  className: string;
  /** 装缩略图时额外叠的类（`.rowIconThumb`） */
  thumbClassName: string;
}) {
  const { Icon, label } = provenanceOf(note);
  /**
   * ❗ 必须 useMemo。这里原先写的是「不用 useMemo：本组件只在 note 变时重渲染，
   *   而正则带了 512 限长」——**两句都是错的**（2026-09-07 审查时核实）：
   *   ① 本组件没有 `React.memo`，父组件 `NoteRow` 也没有。`NoteList` 一重渲染
   *      它就重渲染，而 `focusIdx` 是 `NoteList` 的 state ⇒ **每按一次方向键
   *      整个列表全部重渲染**，不是「只在 note 变时」。
   *   ② 512 限的是**捕获到的 URL 长度**（`[^)\s\n]{1,512}`），不是扫描范围：
   *      没图的笔记要扫完**全文**才能确定没有 `![`。
   *   合起来：加载 300 条后，每一次方向键都是 300 次全文正则扫描。
   */
  const cover = useMemo(() => coverUrlOf(note.content), [note.content]);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showThumb = cover !== null && cover !== failedSrc;

  return (
    <span
      className={showThumb ? `${className} ${thumbClassName}` : className}
      title={label}
      aria-hidden="true"
    >
      {showThumb ? (
        <img
          src={cover}
          alt=""
          loading="lazy"
          decoding="async"
          /* 图没了 / 不是图 → 降级成图标，**不摆碎图** */
          onError={() => setFailedSrc(cover)}
        />
      ) : (
        <Icon size={ICON_SIZE} />
      )}
    </span>
  );
}
