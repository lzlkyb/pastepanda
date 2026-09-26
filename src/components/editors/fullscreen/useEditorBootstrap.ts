/**
 * 宿主与 Rust 侧的**会话对接**：建窗期队列、后续打开事件、编辑器目标同步。
 *
 * 入口协议（Rust 侧）：
 *   建窗时 `open_fullscreen_editor` 把文档塞进队列 → 窗口内前端挂载后
 *   `take_editor_init` 取走建窗期累积的全部文档 → 建标签 → `mark_editor_ready`
 *   把状态翻到 Ready，此后新请求一律走 `md-editor-load` 事件。
 *
 * ❗ 这条队列是必需的（改造前正是它的缺失导致静默丢文档）：双击多选 5 个 .md 时，
 * 后 4 个请求会落在「窗口正在建但前端还没挂载」的空档里 —— 只 emit 事件的话它们
 * 全部丢失，用户看到的是「只打开了第一个」。
 *
 * 从 `FullscreenEditor.tsx`（宿主）拆出，动因是规则 7 的体量红线。
 */
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useToast } from "@/components/Toast";
import { tabLimitMessage, type EditorOpenRequest } from "@/lib/editorTabs";
import type { EditorTab } from "./useEditorTabs";
import type { MutableRefObject } from "react";

export interface EditorBootstrapOptions {
  /** 打开一个文档（可能复用已有标签） */
  open: (req: EditorOpenRequest) => { id: string; reused: boolean; accepted: boolean };
  tabsRef: MutableRefObject<EditorTab[]>;
  /** 活动标签（`set_editor_target` 跟随它，供截图「插入到文档」用） */
  tabs: EditorTab[];
  activeId: string | null;
  /** 退场动画中被复用（极罕见竞态）时重置关闭状态 */
  resetClosing: () => void;
  /**
   * 引导结束（**无论成败**，含取初始数据失败 / 已被上限拒）。
   *
   * ❗ 宿主必须靠它区分「标签为空」的两种含义：还没引导完 = 真的在加载；
   * 已引导完却一个标签都没有 = 初始化彻底失败。少了这个信号，宿主只能把两者
   * 都画成「加载中…」—— 于是失败会伪装成「还在加载」，窗口永远停在那里，
   * 用户既没内容可看也没有任何出口。
   *
   * 传稳定引用（`useCallback`）：它进 effect 依赖数组，换引用会重跑引导。
   */
  onBooted: () => void;
}

export function useEditorBootstrap({
  open,
  tabsRef,
  tabs,
  activeId,
  resetClosing,
  onBooted,
}: EditorBootstrapOptions): void {
  const { toast } = useToast();

  // ─── 建窗期队列 → 标签 ───────────────────────────────
  useEffect(() => {
    let mounted = true;
    void (async () => {
      let items: EditorOpenRequest[] = [];
      try {
        const raw = await invoke<EditorOpenRequest[] | EditorOpenRequest | null>("take_editor_init");
        items = Array.isArray(raw) ? raw : raw ? [raw] : [];
      } catch {
        /* 读不到初始数据也继续：下面会给一个空白文档，否则窗口停在「加载中…」 */
      }
      if (!mounted) return;
      // 被上限拒掉的个数。**先合并计数、最后弹一条**：一次多选 15 个文件时
      // 逐条弹会连刷 3 个一模一样的 toast，比不弹还吵。
      let skipped = 0;
      if (items.length > 0) {
        for (const it of items) if (!open(it).accepted) skipped += 1;
      } else if (tabsRef.current.length === 0) {
        // Rust 没给初始数据（异常路径）：兜一个空白文档，否则窗口停在「加载中…」。
        // ❗ 只在真没有标签时兜：dev 的 StrictMode 会二次挂载，第二次 take 拿到的是
        //   空数组（mark_editor_ready 已清过队列），无条件兜会凭空多出一个空白标签。
        open({ content: "", contentType: null, language: null });
      }
      // 翻到 Ready，并把「建窗期间又来的那几个」取回来（旧后端没这条命令 → 静默）
      try {
        const rest = await invoke<EditorOpenRequest[] | null>("mark_editor_ready");
        if (mounted && Array.isArray(rest)) {
          for (const it of rest) if (!open(it).accepted) skipped += 1;
        }
      } catch { /* 旧后端无此命令：退化为只靠 md-editor-load 事件 */ }
      // ❗ 这条队列以前是**静默**丢文档的：一次多选超过上限时，多出来的几个
      //    既没打开、也没有任何提示 —— 正是本次改造要消灭的那类丢失。
      //    计票不会因 StrictMode 双挂载翻倍：第一遍若跑到 mark_editor_ready，
      //    队列已被清空 → 第二遍 take 得空数组，压根不进循环。
      if (mounted && skipped > 0) toast(tabLimitMessage(skipped), "info");
      // 引导到此结束（无论有没有建出标签、也无论是取数据还是 mark_ready 失败）。
      // 宿主据此把「标签为空」区分为「还在加载」与「初始化失败」—— 后者必须
      // 有出口，否则窗口永远停在「加载中…」。
      if (mounted) onBooted();
    })();
    return () => { mounted = false; };
  }, [open, toast, tabsRef, onBooted]);

  // ─── 后续打开：窗口已存在时 Rust emit md-editor-load ──
  useEffect(() => {
    const unlisten = listen<EditorOpenRequest>("md-editor-load", (e) => {
      // 退场动画中被复用（极罕见竞态）：重置关闭状态，让新内容正常入场
      resetClosing();
      const res = open({ ...e.payload });
      if (!res.accepted) toast(tabLimitMessage(), "info");
    });
    return () => {
      unlisten.then((fn) => fn());
      // V6.19：编辑器关闭 → 清除目标（截图"插入到文档"入口隐藏）
      void invoke("set_editor_target", { editor_path: null });
    };
  }, [open, toast, resetClosing]);

  // 编辑器目标文件跟随活动标签（截图"插入到文档"用）
  const activeFilePath = tabs.find((t) => t.id === activeId)?.filePath ?? null;
  useEffect(() => {
    void invoke("set_editor_target", { editor_path: activeFilePath });
  }, [activeFilePath]);
}
