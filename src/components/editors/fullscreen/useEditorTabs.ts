/**
 * 多标签状态容器：标签列表 / 活动标签 / 元信息上报。
 *
 * ❗ 为什么用「ref 作真相源 + state 作渲染镜像」而不是纯 useState：
 * `open()` 必须**同步**返回「命中已有标签 / 新开 / 被上限拒绝」三态之一，宿主据此
 * 决定 toast 与聚焦。而 React 18 的 `setState(updater)` 里的 updater 是在渲染阶段
 * 才执行的，调用点读不到结果；连续打开多个文件（双击多选 .md）时更不能靠
 * 「等下一次渲染」。所以真相源放在 ref，commit() 同步写 ref + 触发一次渲染。
 *
 * 去重/上限/关闭后焦点这三条**规则**在 `@/lib/editorTabs` 的纯函数里，
 * 本文件只做状态搬运。
 */
import { useCallback, useRef, useState } from "react";
import {
  canOpenMore,
  dedupeKeyOf,
  findTabIndex,
  nextActiveAfterClose,
  type EditorOpenRequest,
  type TabMeta,
} from "@/lib/editorTabs";
import { resolveFullscreenType } from "./registry";

export interface EditorTab {
  /** 标签身份（打开后不变；重命名/另存为不改它） */
  id: string;
  /** 去重键（null = 无稳定身份，每次打开都是新标签） */
  dedupeKey: string | null;
  sourceId: string | null;
  filePath: string | null;
  contentType: string | null;
  language: string | null;
  content: string | null;
  /** 运行期元信息，由文档视图上报 */
  meta: TabMeta;
}

export interface OpenResult {
  /** 命中或新建的标签 id；被上限拒绝时为空串 */
  id: string;
  /** true = 命中已有标签并切过去（未新建、未重载） */
  reused: boolean;
  /** false = 触达上限被拒（宿主据此提示，而不是静默无反应） */
  accepted: boolean;
}

/** 标签 id：不依赖 `crypto.randomUUID`（jsdom / 不同 WebView 上不保证有） */
let tabSeq = 0;
function newTabId(): string {
  tabSeq += 1;
  return `tab-${Date.now().toString(36)}-${tabSeq}`;
}

/**
 * 打开请求 → 标签展示信息（文件名 + 图标）的初值。
 *
 * 只是**初值**：文档视图挂载后会立刻上报真实值（文件名随后续「另存为」变化）。
 * 但仍然要算对，因为标签栏会在同一帧里先渲染出来，初值错了就是一次可见的闪跳。
 */
function initialDisplay(req: EditorOpenRequest): { fileName: string; icon: string } {
  // 图文混排不在 registry 里（它走 Tiptap，不是 CodeMirror 那套），单独登记
  if (req.contentType === "rich") {
    return { fileName: req.sourceId ? "剪贴板图文" : "图文内容", icon: "🖼️" };
  }
  const spec = resolveFullscreenType(req.contentType);
  if (req.filePath) {
    return { fileName: req.filePath.split(/[\\/]/).pop() || spec.defaultFileName, icon: spec.icon };
  }
  if (req.sourceId) return { fileName: "剪贴板内容", icon: spec.icon };
  return { fileName: spec.defaultFileName, icon: spec.icon };
}

function createTab(req: EditorOpenRequest): EditorTab {
  const { fileName, icon } = initialDisplay(req);
  return {
    id: newTabId(),
    dedupeKey: dedupeKeyOf(req),
    sourceId: req.sourceId ?? null,
    filePath: req.filePath ?? null,
    contentType: req.contentType ?? null,
    language: req.language ?? null,
    content: req.content ?? null,
    meta: {
      fileName,
      icon,
      isDirty: false,
      isSaving: false,
      tabError: false,
      // 乐观初值：绝大多数视图能保存。不能保存的（diff）会在挂载后第一帧
      // 由自己上报修正 —— 而「挂载完成 → 用户点得到关闭按钮」之间隔着整段渲染。
      canSave: true,
      focusMode: false,
    },
  };
}

export function useEditorTabs() {
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeId, setActiveIdState] = useState<string | null>(null);
  const tabsRef = useRef<EditorTab[]>([]);
  const activeIdRef = useRef<string | null>(null);

  const commit = useCallback((next: EditorTab[]) => {
    tabsRef.current = next;
    setTabs(next);
  }, []);

  const setActiveId = useCallback((id: string | null) => {
    activeIdRef.current = id;
    setActiveIdState(id);
  }, []);

  /**
   * 打开一份文档。命中已有标签 → **切过去、绝不重载**（重载会冲掉那个标签里
   * 未保存的编辑，那正是这次改造要顺手修掉的现存缺陷）。
   */
  const open = useCallback((req: EditorOpenRequest): OpenResult => {
    const prev = tabsRef.current;
    const key = dedupeKeyOf(req);
    const idx = findTabIndex(prev.map((t) => t.dedupeKey), key);
    if (idx >= 0) {
      const hit = prev[idx];
      setActiveId(hit.id);
      return { id: hit.id, reused: true, accepted: true };
    }
    if (!canOpenMore(prev.length)) {
      return { id: "", reused: false, accepted: false };
    }
    const tab = createTab(req);
    commit([...prev, tab]);
    setActiveId(tab.id);
    return { id: tab.id, reused: false, accepted: true };
  }, [commit, setActiveId]);

  /**
   * 关闭一个标签。返回关闭后应激活的标签 id（null = 已无标签，宿主该关窗）。
   * 只做状态变更，**守卫在宿主**（脏标签要统一列清单，不能每个标签各弹一个框）。
   */
  const close = useCallback((id: string): string | null => {
    const prev = tabsRef.current;
    const rest = prev.filter((t) => t.id !== id);
    if (rest.length === prev.length) return activeIdRef.current;
    const nextActive = nextActiveAfterClose(prev.map((t) => t.id), activeIdRef.current, id);
    commit(rest);
    setActiveId(nextActive);
    return nextActive;
  }, [commit, setActiveId]);

  const select = useCallback((id: string) => {
    setActiveId(id);
  }, [setActiveId]);

  /** 元信息上报。逐字段比较后再 commit —— 文档视图每次渲染都会调它，
   *  无脑 commit 会让标签栏跟着文档的每次渲染重新渲染。 */
  const updateMeta = useCallback((id: string, meta: TabMeta) => {
    const prev = tabsRef.current;
    const i = prev.findIndex((t) => t.id === id);
    if (i < 0) return;
    const cur = prev[i].meta;
    if (
      cur.fileName === meta.fileName &&
      cur.icon === meta.icon &&
      cur.isDirty === meta.isDirty &&
      cur.isSaving === meta.isSaving &&
      cur.tabError === meta.tabError &&
      cur.canSave === meta.canSave &&
      cur.focusMode === meta.focusMode
    ) {
      return;
    }
    const next = prev.slice();
    next[i] = { ...prev[i], meta };
    commit(next);
  }, [commit]);

  return { tabs, activeId, activeIdRef, tabsRef, open, close, select, updateMeta };
}

export type EditorTabsApi = ReturnType<typeof useEditorTabs>;
