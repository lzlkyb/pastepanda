/**
 * NoteListEmpty.tsx —— 笔记列表的加载态与空态。
 *
 * 从 `KnowledgeView` 抽出：它已到规则 #7 的 300 行上限。
 * 空态文案跟「为什么空」强相关（搜不到 / 文件夹空 / 真没笔记），
 * 放一起才不会改了一处忘了另一处。
 */
import type { FolderFilter } from "@/lib/api";
import styles from "../KnowledgeView.module.css";

export function NoteListEmpty({
  loading,
  keyword,
  folderFilter,
}: {
  loading: boolean;
  keyword: string;
  folderFilter: FolderFilter;
}) {
  if (loading) return <div className={styles.stateBox}>正在加载…</div>;

  const kw = keyword.trim();
  const hint = kw
    ? "换个词试试。搜的是标题与正文，也支持拼音首字母。"
    : folderFilter !== "all"
      ? "这个文件夹还是空的。右键笔记可以把它移进来，或者点右上角的＋新建一条。"
      : "在记录模式右键一张卡片、选「转为笔记」，它就会出现在这里。";

  return (
    <div className={styles.stateBox}>
      <div className={styles.icon} aria-hidden="true">
        📚
      </div>
      <div className={styles.title}>{kw ? "没找到匹配的笔记" : "还没有笔记"}</div>
      <div className={styles.hint}>{hint}</div>
    </div>
  );
}
