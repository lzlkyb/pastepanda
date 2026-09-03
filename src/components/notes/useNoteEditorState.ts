/**
 * 笔记编辑的共享状态（B1 #1 宽屏三栏的前提）。
 *
 * **为何必须抽它**：同一套编辑行为现在有两个宿主——
 * - `NoteDialog`：弹窗（转笔记入口，不论窗口多宽都是它）；
 * - `NoteDetailPane`：≥800px 时知识模式的第三栏。
 *
 * 不收口就是两份保存逻辑，而两份中必有一份会忘了某个分支（脏数据守卫、
 * 标题空校验、失败不关窗）——同 A 阶段把幂等收进 `openNoteForCard` 的理由（`↩A-31`）。
 *
 * **Esc 不在这里**：弹窗要抢全局 Esc，而第三栏不应该抢（知识模式下 Esc 可能另有含义）。
 * 这一条留给宿主自己接。
 *
 * 🔴 红线：无 AI。标题与正文只进本机 SQLite。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppStore } from "@/stores/appStore";
import { useToast } from "@/components/Toast";
import { confirmDialog } from "@/lib/confirm";
import { copyToClipboard } from "@/lib/utils";
import { THEMES, DEFAULT_THEME } from "@/lib/theme";
import { noteCreate, noteUpdate, noteSetFolder, noteMarkdown, fetchNoteHistoryIds } from "@/lib/api";

/**
 * 换笔记时才拦的阈值：正文改动少于这么多字就**不拦**，直接丢。
 *
 * 为何不全量拦：第三栏存在的全部理由是「扫着读」（见 `NoteDetailPane` 文件头），
 * 换笔记是这个界面里最高频的动作。每换一条都弹一次确认会直接毁掉这个场景，
 * 而误碰键盘、多敲一两个字本来也不是用户想保的东西。
 *
 * ❗ 代价写清楚：**最多会静默丢掉 9 个字的正文改动**。标题不适用这个阈值
 *   （标题就那么短，改它都是有意的）。
 */
const SWITCH_GUARD_CHARS = 10;

/**
 * 两串之间的「改动量」：去掉公共前缀与公共后缀后，剩下两段的长度之和。
 *
 * 不用编辑距离：那是 O(nm)，而这个函数会在每次换笔记时对整篇正文跑一遍。
 * 不用长度差：把一段话改成等长的另一段话，长度差是 0，但那是真改动。
 *
 * 例：「今天开会记录」→「今天的会议记录」，公共前缀「今天」、公共后缀「记录」，
 * 改动量 = 2 + 3 = 5。
 */
function changedChars(a: string, b: string): number {
  if (a === b) return 0;
  const min = Math.min(a.length, b.length);
  let head = 0;
  while (head < min && a[head] === b[head]) head++;
  // 尾部不能跨过已匹配的头部，否则同一段字符会被两边重复数、算出负数。
  let tail = 0;
  while (tail < min - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return a.length - head - tail + (b.length - head - tail);
}

/** 正在编辑的对象。与 `dialogStore.noteDraft` 同形，第三栏从 `Note` 拼一个即可。 */
export interface NoteEditTarget {
  /** null = 新建；非 null = 编辑已有那条 */
  noteId: string | null;
  /** 来源卡片。null = 与剪贴板无关的独立笔记 */
  historyId: string | null;
  /** 新建后落入的文件夹（B1 #13）。**只在 `noteId === null` 时生效** */
  folderId?: string | null;
  /** 已有标签。只给「复制为 Markdown」的 frontmatter 用；编辑标签是另一条路 */
  tags?: { name: string }[];
  title: string;
  content: string;
}

export function useNoteEditorState({
  target,
  onClose,
  onSaved,
}: {
  target: NoteEditTarget;
  /** 宿主决定「关闭」意味着什么：弹窗 = closeNote；第三栏 = 清选中 */
  onClose: () => void;
  /** 保存成功后。弹窗 = 关窗；第三栏 = 留在原地并刷列表 */
  onSaved?: () => void;
}) {
  const setAppMode = useAppStore((s) => s.setAppMode);
  const selectItem = useAppStore((s) => s.selectItem);
  const themeKey = useAppStore((s) => s.config.theme);
  const { toast } = useToast();

  const [title, setTitle] = useState(target.title);
  const [content, setContent] = useState(target.content);
  const [saving, setSaving] = useState(false);

  /**
   * 脏数据的**基线**。一开始是打开时的值，但保存成功 / 恢复版本后要重新对齐。
   *
   * ❗ 原先直接拿 `target.title/content` 当基线，在第三栏里是错的：
   *   那个壳保存后不关闭、`note` 属性也不会变，于是「未保存」标记存下来不掉，
   *   关栏时还会白弹一次「放弃修改」。（B1 #1 遗留，随 #4 一并修。）
   */
  const [baseTitle, setBaseTitle] = useState(target.title);
  const [baseContent, setBaseContent] = useState(target.content);

  const isDark = useMemo(
    () => THEMES.find((t) => t.key === (themeKey || DEFAULT_THEME))?.dark ?? false,
    [themeKey],
  );

  // 脏数据：与基线比，而不是“敲过键就算脏”——改完又改回去不应该拦用户
  const isDirty = title !== baseTitle || content !== baseContent;

  /**
   * 来源卡片。从已加载的 history 里找，而不是发 IPC 查：
   * 找不到就是「原卡片已删」，而这正是我们要展示的状态（规划 §6 生命周期）。
   *
   * ❗ history 是分页/筛选后的列表。卡片很旧没被加载时也会算成「已删」——
   *   代价只是少一个跳转按钮，而为此多发一次 IPC 不值。
   */
  const sourceItem = useAppStore((s) =>
    target.historyId ? s.history.find((h) => h.id === target.historyId) : undefined,
  );

  const save = useCallback(async (): Promise<boolean> => {
    const t = title.trim();
    if (!t) {
      toast("标题不能为空", "error");
      return false;
    }
    setSaving(true);
    // 失败时**不弹回调**（规则 #15.3）：api 层已经弹过错了，
    // 宿主若据此关窗就等于把用户刚写的正文丢掉。
    let ok: boolean;
    // O-9：改标题会让其它笔记里的 [[旧标题]] 全部失效，后端会自动重写。
    // 重写了就必须告知：用户只改了一个标题，却有几篇别的笔记正文被动了。
    let relinked = 0;
    if (target.noteId) {
      const rep = await noteUpdate(target.noteId, t, content);
      ok = rep !== null;
      relinked = rep?.relinked ?? 0;
    } else {
      const created = await noteCreate(target.historyId, t, content);
      ok = created !== null;
      // 新建时归档。`note_create` 不收 folder_id（见 note.rs 里那条注释），
      // 所以多发一次 IPC。归档失败不算保存失败：笔记已经落盘了，
      // 只是停在「未分类」，api 层已弹过错（规则 #15.3）。
      if (created && target.folderId) await noteSetFolder(created.id, target.folderId);
    }
    setSaving(false);
    if (!ok) return false;
    // 基线对齐到刚存下去的内容：第三栏保存后不关闭，不对齐就一直显示「未保存」。
    setBaseTitle(t);
    setBaseContent(content);
    // 并进同一条 toast 而不另弹一个：两条叠在一起反而让人漏看后一条。
    const saved = target.noteId ? "已保存" : target.historyId ? "已转为笔记" : "已创建笔记";
    toast(
      relinked > 0 ? `${saved}，并更新了 ${relinked} 篇笔记里的 [[引用]]` : saved,
      "success",
      relinked > 0 ? 5000 : undefined,
    );
    onSaved?.();
    return true;
  }, [title, content, target.noteId, target.historyId, target.folderId, toast, onSaved]);

  /**
   * 切换到另一条笔记（或让出第三栏）前的守卫。返回 `true` = 可以继续。
   *
   * ❗ 为何不直接用 `requestClose`：那个只要**一个字符**不同就拦，而换笔记是
   *   扫读时最高频的动作——那会变成每点一条弹一次。这里只拦两种情况：
   *   标题被改过，或正文改动 ≥ [`SWITCH_GUARD_CHARS`]。
   *
   * ❗ 这个函数存在的原因：改之前只有点✕ 那一个入口有守卫，而实际上有**五个**
   *   入口会把第三栏换掉（点另一条 / 删当前这条 / 点「问」/ 点参考笔记 / 窗口缩小），
   *   它们全部直接改 `activeNote`，而本组件带 `key={note.id}`——一换就重挂载，
   *   草稿随组件一起没了。
   */
  const guardSwitch = useCallback(async (): Promise<boolean> => {
    const titleChanged = title !== baseTitle;
    if (!titleChanged && changedChars(content, baseContent) < SWITCH_GUARD_CHARS) return true;
    return await confirmDialog({
      title: "有未保存的修改",
      message: "离开这条笔记后，这些修改会被丢弃。",
      confirmText: "丢弃并继续",
      cancelText: "留在这条",
    });
  }, [title, baseTitle, content, baseContent]);

  /** 带脏数据守卫的关闭（点✕）。这里是**只要有一点不同就问**：
   *  关闭是一个明确的「我完事了」动作，不像换笔记那样会连着做很多次。 */
  const requestClose = useCallback(async () => {
    if (isDirty) {
      const ok = await confirmDialog({
        title: "放弃修改",
        message: "笔记有未保存的修改，关闭后将丢弃。",
        confirmText: "放弃",
      });
      if (!ok) return;
    }
    onClose();
  }, [isDirty, onClose]);

  // 挂载时对一次角标集：笔记可能是从知识模式进来的，而那边未必拉过
  useEffect(() => {
    void fetchNoteHistoryIds();
  }, []);

  /**
   * 复制为 Markdown。拼接走后端，与目录导出是**同一个生成函数**（规则 #11）。
   * 两个出口各拼一遍的话，格式会慢慢漂成两种，而那时已经导出过很多次了。
   * 传的是屏幕上的草稿，所以未保存的修改也能复制。
   */
  const copyAsMarkdown = useCallback(async () => {
    const md = await noteMarkdown(
      title.trim() || "无标题笔记",
      content,
      (target.tags ?? []).map((t) => t.name),
    );
    if (md === null) return; // api 层已弹错，不把 null 写进剪贴板
    const ok = await copyToClipboard(md);
    toast(ok ? "已复制为 Markdown" : "复制失败", ok ? "success" : "error");
  }, [title, content, target.tags, toast]);

  /**
   * 查看原卡片：切回记录模式并选中它，**不关编辑器**。
   * 关了就可能丢未保存的正文；用户自己关掉后自然就看到那张已选中的卡片。
   */
  const viewSource = useCallback(() => {
    if (!target.historyId) return;
    setAppMode("record");
    selectItem(target.historyId);
  }, [target.historyId, setAppMode, selectItem]);

  /**
   * 把外部已经写入库的内容同步进来（目前只有 B1 #4 的「恢复版本」）。
   * 同时移基线——它已经是库里的值了，不该算未保存。
   */
  const applyPersisted = useCallback((nextTitle: string, nextContent: string) => {
    setTitle(nextTitle);
    setContent(nextContent);
    setBaseTitle(nextTitle);
    setBaseContent(nextContent);
  }, []);

  return {
    title,
    setTitle,
    content,
    setContent,
    applyPersisted,
    isDirty,
    saving,
    isDark,
    sourceItem,
    save,
    guardSwitch,
    requestClose,
    copyAsMarkdown,
    viewSource,
  };
}
