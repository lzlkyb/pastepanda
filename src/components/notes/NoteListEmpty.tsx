/**
 * NoteListEmpty.tsx —— 笔记列表的加载态与空态。
 *
 * 从 `KnowledgeView` 抽出：它已到规则 #7 的 300 行上限。
 * 空态文案跟「为什么空」强相关（搜不到 / 文件夹空 / 真没笔记），
 * 放一起才不会改了一处忘了另一处。
 *
 * 🔴 红线：无 AI。
 */
import { BookOpen, CalendarDays, SearchX, FolderOpen, Plus, X } from "lucide-react";
import type { FolderFilter } from "@/lib/api";
import { useAppStore } from "@/stores/appStore";
import { formatHotkey } from "@/components/settings/HotkeyRecorder";
import { isDailyFilter } from "./DailySection";
import styles from "../KnowledgeView.module.css";

export function NoteListEmpty({
  loading,
  keyword,
  folderFilter,
  onNew,
  onClearSearch,
}: {
  loading: boolean;
  keyword: string;
  folderFilter: FolderFilter;
  /** 新建笔记（落在当前文件夹）。不传就不摆那个按钮 */
  onNew?: () => void;
  /** 清空搜索词。不传就不摆 */
  onClearSearch?: () => void;
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
  const inFolder = !kw && !daily && folderFilter !== "all";

  // 速记空态是**把热键教给用户的地方**（设计稿 §1）：
  // 一个全局热键如果从来不在界面上出现，等于没做。
  const hint = kw
    ? "换个词试试。搜的是标题与正文，也支持拼音首字母。"
    : daily
      ? `复制一段内容后按 ${formatHotkey(dailyHotkey || "ctrl+alt+d")}，它就直接进今天这条；或者右键卡片选「追加到今日速记」。`
      : inFolder
        ? "这个文件夹还是空的。把笔记拖进来，或者直接在这里新建一条。"
        : "在记录模式右键一张卡片、选「转为笔记」，它就会出现在这里。";

  const title = kw ? "没找到匹配的笔记" : daily ? "这天还没记东西" : inFolder ? "这个文件夹是空的" : "还没有笔记";

  // 四种空态各自的图标。全部 lucide（批 0 已经把行内的 emoji 换了，
  // 空态这个 34px emoji 是最后一个）。
  const Icon = kw ? SearchX : daily ? CalendarDays : inFolder ? FolderOpen : BookOpen;

  return (
    <div className={styles.stateBox}>
      {/* 图标底 + 旋转虚线环，同记录模式的空态。
          环是纯装饰，所以整块 aria-hidden——信息全在下面的标题与提示里。 */}
      <div className={styles.emptyWrap} aria-hidden="true">
        <div className={styles.emptyRing} />
        <div className={styles.emptyIcon}>
          <Icon size={30} strokeWidth={1.8} />
        </div>
      </div>
      <div className={styles.title}>{title}</div>
      <div className={styles.hint}>{hint}</div>

      {/* 主动作。按「为什么空」给不同的出口：
          搜不到 → 清空搜索；文件夹空 / 真没笔记 → 新建。

          ❗ 速记空态不摆按钮：那条提示教的是热键，
            而“在这里新建”会把用户从那条更有用的路径上拉走。
          ❗ 回收站为空不走这个组件（TrashPanel 自己有一份），本来就不应该有按钮。 */}
      {(kw ? !!onClearSearch : !daily && !!onNew) && (
        <div className={styles.emptyActions}>
          {kw ? (
            <button
              type="button"
              className={styles.emptyBtn}
              onClick={onClearSearch}
            >
              <X size={14} />
              清空搜索
            </button>
          ) : (
            <button
              type="button"
              className={`${styles.emptyBtn} ${styles.emptyBtnPrimary}`}
              onClick={onNew}
            >
              <Plus size={14} />
              {inFolder ? "在这里新建" : "新建第一条笔记"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
