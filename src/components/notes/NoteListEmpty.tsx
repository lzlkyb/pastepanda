/**
 * NoteListEmpty.tsx —— 笔记列表的加载态与空态。
 *
 * 从 `KnowledgeView` 抽出：它已到规则 #7 的 300 行上限。
 * 空态文案跟「为什么空」强相关（搜不到 / 文件夹空 / 真没笔记），
 * 放一起才不会改了一处忘了另一处。
 */
import type { FolderFilter } from "@/lib/api";
import { useAppStore } from "@/stores/appStore";
import { formatHotkey } from "@/components/settings/HotkeyRecorder";
import { isDailyFilter } from "./DailySection";
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
  // 热键从配置读而不是写死：用户改过之后这里再教他按 Ctrl+Alt+D 就是在说谎
  const dailyHotkey = useAppStore((s) => s.config?.daily_note_hotkey);

  // 骨架屏而不是一行「正在加载…」。两个理由：
  // ① 文字只有一行高，数据一到列表突然撑满，高度会跳一下；
  // ② 骨架把「一会儿会出现几条、每条长什么样」提前告诉你了。
  // 扫光关键帧与卡片列表共用（styles/surface.css 的 pp-skeleton-shimmer）。
  if (loading) {
    return (
      <div className={styles.skelList} aria-busy="true" aria-label="正在加载笔记">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className={styles.skelRow}>
            <div className={`${styles.skelBar} ${styles.skelTitle}`} />
            <div className={`${styles.skelBar} ${styles.skelText}`} />
            <div className={`${styles.skelBar} ${styles.skelMeta}`} />
          </div>
        ))}
      </div>
    );
  }

  const kw = keyword.trim();
  const daily = isDailyFilter(folderFilter);

  // 速记空态是**把热键教给用户的地方**（设计稿 §1）：
  // 一个全局热键如果从来不在界面上出现，等于没做。
  const hint = kw
    ? "换个词试试。搜的是标题与正文，也支持拼音首字母。"
    : daily
      ? `复制一段内容后按 ${formatHotkey(dailyHotkey || "ctrl+alt+d")}，它就直接进今天这条；或者右键卡片选「追加到今日速记」。`
      : folderFilter !== "all"
        ? "这个文件夹还是空的。右键笔记可以把它移进来，或者点右上角的＋新建一条。"
        : "在记录模式右键一张卡片、选「转为笔记」，它就会出现在这里。";

  const title = kw ? "没找到匹配的笔记" : daily ? "这天还没记东西" : "还没有笔记";

  return (
    <div className={styles.stateBox}>
      <div className={styles.icon} aria-hidden="true">
        {daily ? "📅" : "📚"}
      </div>
      <div className={styles.title}>{title}</div>
      <div className={styles.hint}>{hint}</div>
    </div>
  );
}
