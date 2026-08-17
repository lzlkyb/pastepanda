import { create } from "zustand";
import { logger } from "@/lib/logger";
import type { SemanticHit } from "@/lib/api/semantic";
import { reorderAction } from "@/lib/quickOrder";
import { splitTableToRows } from "@/lib/tableSplit";

// ===== 数据类型 =====

export interface Tag {
  id: string;
  name: string;
  color: string;
  source: "manual" | "auto"; // ★ 新增：标签来源
  created_at: string;
}

export interface Group {
  id: string;
  name: string;
  color: string;
  icon: string;
  sort_order: number;
  created_at: string;
}

export interface HistoryItem {
  id: string;
  text: string;
  time: string;
  /** rich = 图文混排（CF_HTML 采集）；doc = 结构化文档；diagram = 流程图（JSON 存 content） */
  type: "text" | "image" | "file" | "rich" | "doc" | "diagram";
  content: string; // 空 / 图片路径 / 文件路径JSON
  pinned: boolean;
  source: string;
  workspace: string;
  md5?: string;
  pinyin_initials?: string;
  /** 预计算的时间戳（毫秒），避免 sort 中反复 new Date() */
  timeStamp?: number;
  group_id?: string | null;
  tags?: Tag[];
  /** 来源应用真实图标文件名（捕获剪贴板时从 exe 提取） */
  source_icon?: string | null;
  /** 内容类型（由 Rust ContentClassifier 在插入时计算并持久化） */
  content_type?: string;
  /** 图片条目的 OCR 识别文本（后端 image_ocr_cache 回填）。
   *  undefined=从未识别过；""=识别过但无文字；非空=识别结果。
   *  识别文本是本地 OCR 产物，不出本机。 */
  ocr_text?: string;
}

/** 顶部标签页筛选。注：没有 "rich" —— 图文混排归入 "image"（见下方过滤逻辑） */
export type FilterType = "all" | "text" | "image" | "file" | "pinned";

// 时间范围筛选
export type TimeFilter = "all" | "today" | "week" | "month";

// 来源应用筛选
export type SourceFilter = string | ""; // 空字符串表示全部

// 分组筛选
export type GroupFilter = "all" | "ungrouped" | string; // "all"=全部, "ungrouped"=未分组, string=group_id

export interface AppConfig {
  hotkey: string;
  theme: string;
  auto_cleanup_days: number;
  /** v6.1 自我净化开关：保护常用内容（打标签/粘贴过/搜索找回过）不过期。默认开 */
  preserve_valued_content: boolean;
  auto_strip: boolean;
  sequential_loop: boolean;
  hide_on_focus_out: boolean;
  lan_sync_enabled: boolean;
  always_on_top: boolean;
  auto_startup: boolean;
  sequential_hotkey: string;
  select_all_hotkey: string;
  current_workspace: string;
  workspaces: string[];
  double_click_action: "copy" | "preview"; // 双击列表行为
  hover_mode: "off" | "inline" | "popover"; // 鼠标悬停卡片交互模式
  source_icon_mode: "emoji" | "app"; // 来源图标显示方式
  timeline_enabled: boolean; // 时间线功能开关
  stack_toggle_hotkey: string; // 栈模式开关快捷键
  stack_paste_hotkey: string; // 栈顶粘贴快捷键
  quick_paste_hotkey: string; // 快捷粘贴面板快捷键（类 Win+V）
  screenshot_hotkey: string; // 截图标注快捷键（v6.18 截图功能）
  auto_frame_window: boolean; // 截图自动框选光标所在窗口（微信同款，v6.19）
  auto_chain_after_screenshot: string; // 截图完成后自动执行的动作链 id（空=不自动，仅纯本地步骤）
  quick_paste_layout: "grid" | "list"; // 快捷粘贴面板布局：grid=双栏网格，list=单栏列表
  skip_sensitive: boolean; // 修复 U36：不记录匹配密钥/凭证模式的内容
  excluded_apps: string; // 修复 U36：应用排除名单（逗号分隔，命中来源应用则不记录）
  md_save_to_history: boolean; // 全屏编辑器中编辑 .md 文件保存时，是否同时写入剪贴板历史
  md_auto_save: boolean; // 全屏编辑器输入停顿后自动回写（卡片→数据库 / 文件→磁盘）
  markdown_preview_line_numbers: boolean; // 全屏编辑器 markdown 预览行号（块级编号 + 代码行号），预览面板标题栏切换
  window_animation: boolean; // 弹框与全屏窗口打开/关闭动画（方案 B 玻璃浮升），关闭后即时显隐
  doc_capture: boolean; // P1：结构化文本复制保留 CF_HTML（文档保真采集）
  paste_format_default: "auto" | "plain"; // P5：doc/rich 粘贴默认格式（auto=富格式，plain=纯文本）
  table_split_enabled: boolean; // 表格拆分入栈（方案 A/B）总开关，默认开
  table_split_format: "raw" | "field-value"; // 拆行后每条的文本格式：raw=原始行，field-value=字段: 值
  table_split_include_header: boolean; // 拆行时是否保留表头行，默认排除
}

// ===== Store 接口 =====

interface AppState {
  // 数据
  history: HistoryItem[];
  config: AppConfig;
  groups: Group[];
  tags: Tag[];

  /** history 变更版本号：任何修改 history 的 action 都 +1。
   *  作为 getFilteredItems 缓存键的一部分，替代脆弱的 history.length——
   *  长度不变但内容变化（或忘记清 _filterCache）时，length 键会命中脏缓存，版本号不会 */
  historyVersion: number;
  /** history 整体替换信号：仅 setHistory 递增。
   *  useLoadMore 监听它重置 hasMore——导入/切换工作区等整体换列表场景下，
   *  若此前已滚动到底（hasMore=false），不重置就永远无法再加载更多 */
  historyResetSeq: number;

  // UI 状态
  searchKeyword: string;
  /** M5-2 语义命中（开关开启时并行产生；关闭/失败为空） */
  semanticHits: SemanticHit[];
  filterType: FilterType;
  timeFilter: TimeFilter;
  sourceFilter: SourceFilter;
  groupFilter: GroupFilter;
  selectedTagIds: string[];
  selectedIds: Set<string>;
  focusId: string | null;
  lastClickedId: string | null;
  seqPointer: number;
  seqTotal: number;
  paused: boolean;
  undoStack: HistoryItem[][]; // 撤销栈，每项是一组被删除的 items
  searchHistory: string[]; // 搜索历史记录

  // 搜索模式（关键词激活时，列表数据源切换为后端全量搜索结果，
  // 不再 filter 分页加载的内存窗口，从而能搜到未加载的记录）
  searchResults: HistoryItem[] | null; // null = 非搜索模式 / 尚未加载
  searchResultsKey: string; // 产生 searchResults 的查询签名（buildSearchKey）
  searchLoading: boolean; // 搜索查询进行中

  // 剪贴板栈
  stackMode: boolean; // 栈模式是否激活
  stackItems: HistoryItem[]; // 待粘贴栈（index 0 = 栈顶 = 下一个粘贴）
  stackDoneIds: Set<string>; // 本轮已粘贴的条目 ID（卡片变灰）
  stackPasted: number; // 本轮实际已粘贴条数
  stackCollected: number; // 本轮真实收集总条数（含被 50 条上限截断丢弃的，进度分母用它，避免虚高）
  stackPasteAllActive: boolean; // U58：「全部粘贴」循环进行中（用于显示进度条与中止按钮）
  /** P3 粘贴+Tab 推进开关：开启后每次栈顶粘贴成功后自动补发 Tab 键。默认关 */
  stackTabAdvance: boolean;
  /** 表格拆分：最近一次拆分的原始整表文本 + 拆出的条目 id 列表，供「撤销拆分」使用。null = 无可撤销 */
  stackLastSplit: { originalText: string; itemIds: string[] } | null;

  // 动作
  setHistory: (items: HistoryItem[]) => void;
  appendHistory: (items: HistoryItem[]) => void;
  prependItem: (item: HistoryItem) => void;
  moveToTop: (id: string, newTime: string) => void;
  removeItems: (ids: string[]) => void;
  undoDelete: () => HistoryItem[] | null;
  togglePin: (id: string) => void;
  setPinned: (id: string, pinned: boolean) => void;
  reorderItems: (fromId: string, toId: string) => void;
  clearAll: () => void;

  setSearchKeyword: (kw: string) => void;
  setSemanticHits: (hits: SemanticHit[]) => void;
  setSearchResults: (results: HistoryItem[] | null, key: string) => void;
  setSearchLoading: (loading: boolean) => void;
  setFilterType: (ft: FilterType) => void;
  setTimeFilter: (tf: TimeFilter) => void;
  setSourceFilter: (sf: SourceFilter) => void;
  setGroupFilter: (gf: GroupFilter) => void;
  toggleTagFilter: (tagId: string) => void;
  clearTagFilters: () => void;
  setGroups: (groups: Group[]) => void;
  setTags: (tags: Tag[]) => void;
  addSearchHistory: (kw: string) => void;
  removeSearchHistory: (kw: string) => void;
  clearSearchHistory: () => void;
  selectItem: (id: string, multi?: boolean, range?: boolean) => void;
  clearSelection: () => void;
  selectAll: () => void;

  setSeqPointer: (p: number) => void;
  resetSeqPointer: () => void;
  setPaused: (p: boolean) => void;

  // 剪贴板栈动作
  setStackMode: (active: boolean) => void;
  stackPush: (item: HistoryItem) => void;
  stackMarkPasted: () => void;
  /** P1 拖拽重排：把 fromId 拖到 toId 的位置（仅在未粘贴的 stackItems 中排序，不影响已粘贴项） */
  stackReorder: (fromId: string, toId: string) => void;
  /** P1 星号删除角标：从 stackItems 中直接移除该条（不粘贴，不计入已粘贴统计） */
  stackRemoveItem: (id: string) => void;
  /** P3 粘贴+Tab 开关取反 */
  toggleStackTabAdvance: () => void;
  /** P4 模板库载入：替换当前未粘贴的 stackItems、自动进入栈模式，保留已有的已粘贴统计 */
  stackLoadTemplate: (items: { type: HistoryItem["type"]; text: string; content: string }[]) => void;
  /** 表格拆分（方案 A/B）：命中表格则按行拆分逐条入栈并返回拆分统计；未命中/非文本/非栈模式则降级为普通 stackPush 并返回 null */
  stackPushOrSplit: (item: HistoryItem) => { splitCount: number; totalRows: number } | null;
  /** 撤销最近一次表格拆分：移除还在队列中的拆分行，还原为一条原始整表文本（已粘贴的行不受影响） */
  stackUndoSplit: () => void;
  /** 合并粘贴成功后调用：把参与合并的那几条从未粘贴队列中移除并标记为已粘贴，避免后续逐条/全部粘贴时重复粘贴同一批内容 */
  stackConsumeMerged: (ids: string[]) => void;
  exitStackMode: () => void;

  updateConfig: (partial: Partial<AppConfig>) => void;

  // 真实来源图标缓存（source_icon 文件名或 source → asset:// URL）
  // 提升到全局 store 避免 N 个组件各自维护一份 useState
  realIconCache: Record<string, string | null>;
  setRealIconUrl: (key: string, url: string | null) => void;

  // 计算属性（带缓存）
  _filterCache: { key: string; result: HistoryItem[] } | null;
  getFilteredItems: () => HistoryItem[];
  getSelectedItems: () => HistoryItem[];
}

// ===== 默认配置 =====

export const DEFAULT_CONFIG: AppConfig = {
  hotkey: "ctrl+alt+v",
  theme: "light",
  auto_cleanup_days: 30,
  preserve_valued_content: true,
  auto_strip: false,
  sequential_loop: false,
  hide_on_focus_out: false,
  lan_sync_enabled: false,
  always_on_top: false,
  auto_startup: false,
  sequential_hotkey: "ctrl+alt+q",
  select_all_hotkey: "ctrl+a",
  current_workspace: "默认",
  workspaces: ["默认"],
  double_click_action: "preview",
  hover_mode: "popover",
  source_icon_mode: "app",
  timeline_enabled: false,
  stack_toggle_hotkey: "ctrl+alt+k",
  stack_paste_hotkey: "ctrl+alt+p",
  quick_paste_hotkey: "alt+v",
  screenshot_hotkey: "ctrl+alt+a",
  auto_frame_window: true, // 默认开启：截图自动框选光标所在窗口
  auto_chain_after_screenshot: "", // 默认不自动执行动作链
  quick_paste_layout: "grid",
  skip_sensitive: false,
  excluded_apps: "",
  md_save_to_history: true,
  md_auto_save: true,
  markdown_preview_line_numbers: true,
  window_animation: true,
  doc_capture: true,
  paste_format_default: "auto",
  table_split_enabled: true,
  table_split_format: "raw",
  table_split_include_header: false,
};

// ===== 搜索模式辅助 =====

/**
 * 计算搜索查询签名：当前关键词 + 全部筛选条件 + 工作区 + 数据版本号。
 * 后端搜索结果（searchResults）只有在签名与当前一致时才视为新鲜；
 * 任一筛选变化或历史数据变更（historyVersion 自增）都会使缓存结果失效。
 * 供 getFilteredItems（判断新鲜）与 App.tsx 搜索编排 effect（决定是否重新查询）共用。
 */
export function buildSearchKey(s: {
  searchKeyword: string;
  filterType: FilterType;
  timeFilter: TimeFilter;
  sourceFilter: SourceFilter;
  groupFilter: GroupFilter;
  selectedTagIds: string[];
  config: AppConfig;
  historyVersion: number;
}): string {
  return `${s.searchKeyword}|${s.filterType}|${s.timeFilter}|${s.sourceFilter}|${s.groupFilter}|${s.selectedTagIds.join(",")}|${s.config.current_workspace}|v${s.historyVersion}`;
}

// ===== Store =====

export const useAppStore = create<AppState>((set, get) => ({
  // 数据
  history: [],
  config: DEFAULT_CONFIG,
  groups: [],
  tags: [],
  historyVersion: 0,
  historyResetSeq: 0,

  // UI 状态
  searchKeyword: "",
  semanticHits: [],
  filterType: "all",
  timeFilter: "all",
  sourceFilter: "",
  groupFilter: "all",
  selectedTagIds: [],
  selectedIds: new Set(),
  focusId: null,
  lastClickedId: null,
  seqPointer: 0,
  seqTotal: 0,
  paused: false,
  undoStack: [],
  stackMode: false,
  stackItems: [],
  stackDoneIds: new Set(),
  stackPasted: 0,
  stackCollected: 0,
  stackPasteAllActive: false,
  stackTabAdvance: false,
  stackLastSplit: null,
  realIconCache: {},
  searchHistory: (() => {
    try {
      const saved = localStorage.getItem("searchHistory");
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  })(),
  searchResults: null,
  searchResultsKey: "",
  searchLoading: false,

  // 数据操作
  setHistory: (items) =>
    set((s) => ({
      history: items,
      _filterCache: null,
      historyVersion: s.historyVersion + 1,
      // 整体替换列表（初始加载/导入/切换工作区）→ 重新允许分页加载
      historyResetSeq: s.historyResetSeq + 1,
    })),
  appendHistory: (items) =>
    set((s) => {
      // 去重：过滤掉已存在于 history 中的 id，防止并发分页请求导致重复行
      const existingIds = new Set(s.history.map((h) => h.id));
      const deduped = items.filter((it) => !existingIds.has(it.id));
      return { history: [...s.history, ...deduped], historyVersion: s.historyVersion + 1 };
    }),
  prependItem: (item) =>
    set((s) => {
      // 去重：如果已存在相同 id 的记录，保留旧数据的非空字段，更新时间和内容
      const dupIdx = s.history.findIndex(h => h.id === item.id);
      if (dupIdx >= 0) {
        const oldItem = s.history[dupIdx];
        const updated = {
          ...oldItem,
          ...item,
          source: item.source || oldItem.source,
          content: item.content || oldItem.content,
          pinned: item.pinned !== undefined ? item.pinned : oldItem.pinned,
          md5: item.md5 || oldItem.md5,
          pinyin_initials: item.pinyin_initials || oldItem.pinyin_initials,
        };
        // 修复 Low（Zustand 反模式）：_filterCache 通过返回 partial 清除，而非原地突变 s
        // focusId 也要清：理由同下方新增分支（重复复制同一段内容也是一次“刚复制”）
        return { history: [updated, ...s.history.slice(0, dupIdx), ...s.history.slice(dupIdx + 1)], _filterCache: null, historyVersion: s.historyVersion + 1, focusId: null };
      }
      // 限制前端缓存最大 500 条，防止内存泄漏（淘汰时跳过 pinned 条目，避免收藏项消失）
      if (s.history.length >= 500) {
        const lastUnpinnedIdx = [...s.history].map((h) => h.pinned).lastIndexOf(false);
        const trimmed = lastUnpinnedIdx >= 0
          ? [...s.history.slice(0, lastUnpinnedIdx), ...s.history.slice(lastUnpinnedIdx + 1)]
          : s.history.slice(0, 499); // 全是 pinned 的极端情况才强制截断
        return { history: [item, ...trimmed], _filterCache: null, historyVersion: s.historyVersion + 1, focusId: null };
      }
      // focusId 清空：新内容入库 = 一次“刚复制”，AI 快捷栏靠 focusId ?? history[0]
      // 定位目标，不清的话用户上次留下的焦点会让它一直指着旧条目，
      // 刚复制的那条反而没人管——跟“复制即用”直接打架。
      return { history: [item, ...s.history], _filterCache: null, historyVersion: s.historyVersion + 1, focusId: null };
    }),
  // 智能合并：将已有记录移到顶部并更新时间
  moveToTop: (id: string, newTime: string) =>
    set((s) => {
      const idx = s.history.findIndex((h) => h.id === id);
      if (idx < 0) return s;
      const item = { ...s.history[idx], time: newTime };
      const newHistory = [item, ...s.history.slice(0, idx), ...s.history.slice(idx + 1)];
      // 修复 Low（Zustand 反模式）：通过返回 partial 清缓存（重排不改变 length，缓存键不会自动失效）
      // 同样清 focusId：这条路径是“又复制了一次已存在的内容”，对用户而言
      // 与复制一段全新内容无区别，漏了就会出现“逆向合并后 AI 栏没跟上”。
      return { history: newHistory, _filterCache: null, historyVersion: s.historyVersion + 1, focusId: null };
    }),
  removeItems: (ids) =>
    set((s) => {
      const idSet = new Set(ids);
      const deleted = s.history.filter((h) => idSet.has(h.id));
      // 修复 U13：被删的是当前焦点项时，焦点移到最近的存活邻居（优先后一项），
      // 避免焦点置空后键盘导航跳回列表顶部
      let nextFocus = s.focusId && idSet.has(s.focusId) ? null : s.focusId;
      if (nextFocus === null && s.focusId) {
        const items = s.getFilteredItems();
        const idx = items.findIndex((h) => h.id === s.focusId);
        if (idx >= 0) {
          for (let i = idx + 1; i < items.length; i++) {
            if (!idSet.has(items[i].id)) { nextFocus = items[i].id; break; }
          }
          if (nextFocus === null) {
            for (let i = idx - 1; i >= 0; i--) {
              if (!idSet.has(items[i].id)) { nextFocus = items[i].id; break; }
            }
          }
        }
      }
      return {
        history: s.history.filter((h) => !idSet.has(h.id)),
        selectedIds: new Set([...s.selectedIds].filter((id) => !idSet.has(id))),
        focusId: nextFocus,
        // 仅在确实删除了条目时才记录撤销批次，避免空批次消耗撤销额度
        undoStack: deleted.length > 0 ? [deleted, ...s.undoStack].slice(0, 10) : s.undoStack,
        _filterCache: null,
        historyVersion: s.historyVersion + 1,
      };
    }),
  undoDelete: () => {
    const s = get();
    if (s.undoStack.length === 0) return null;
    const [restored, ...rest] = s.undoStack;
    set({
      history: [...restored, ...s.history],
      undoStack: rest,
      _filterCache: null,
      historyVersion: s.historyVersion + 1,
    });
    return restored;
  },
  togglePin: (id) =>
    set((s) => ({
      // 修复 Low（Zustand 反模式）：通过返回 partial 清缓存，而非原地突变 s
      history: s.history.map((h) =>
        h.id === id ? { ...h, pinned: !h.pinned } : h
      ),
      _filterCache: null,
      historyVersion: s.historyVersion + 1,
    })),
  // 设置权威置顶状态（由后端 toggle_pin 返回值驱动，避免与本地状态漂移时被 togglePin 的盲目取反打反）
  setPinned: (id, pinned) =>
    set((s) => ({
      history: s.history.map((h) =>
        h.id === id ? { ...h, pinned } : h
      ),
      _filterCache: null,
      historyVersion: s.historyVersion + 1,
    })),
  // 拖拽排序：将 fromId 移动到 toId 之前（在原始 history 中操作，不改变置顶排序）
  reorderItems: (fromId: string, toId: string) =>
    set((s) => {
      const fromIdx = s.history.findIndex((h) => h.id === fromId);
      const toIdx = s.history.findIndex((h) => h.id === toId);
      if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return s;
      const newHistory = [...s.history];
      const [moved] = newHistory.splice(fromIdx, 1);
      newHistory.splice(toIdx, 0, moved);
      return { history: newHistory, _filterCache: null, historyVersion: s.historyVersion + 1 };
    }),
  clearAll: () =>
    set((s) => ({
      history: [],
      selectedIds: new Set(),
      focusId: null,
      _filterCache: null,
      historyVersion: s.historyVersion + 1,
    })),

  // 搜索/筛选（防抖已在 TopBar 中处理，此处直接同步更新）
  setSearchKeyword: (kw) => {
    set({
      searchKeyword: kw,
      selectedIds: new Set(),
      focusId: null,
      lastClickedId: null,
      // 清空关键词 → 退出搜索模式，丢弃后端搜索结果（回到内存窗口过滤）
      ...(kw.trim() ? {} : { searchResults: null, searchResultsKey: "", searchLoading: false }),
    });
  },
  setSearchResults: (results, key) =>
    set({ searchResults: results, searchResultsKey: key, searchLoading: false }),
  setSemanticHits: (hits) => set({ semanticHits: hits }),
  setSearchLoading: (loading) => set({ searchLoading: loading }),
  setFilterType: (ft) => set({ filterType: ft, selectedIds: new Set(), focusId: null, lastClickedId: null }),
  setTimeFilter: (tf) => set({ timeFilter: tf, selectedIds: new Set(), focusId: null, lastClickedId: null }),
  setSourceFilter: (sf) => set({ sourceFilter: sf, selectedIds: new Set(), focusId: null, lastClickedId: null }),
  setGroupFilter: (gf) => set({ groupFilter: gf, selectedIds: new Set(), focusId: null, lastClickedId: null }),
  toggleTagFilter: (tagId) =>
    set((s) => {
      const next = s.selectedTagIds.includes(tagId)
        ? s.selectedTagIds.filter((id) => id !== tagId)
        : [...s.selectedTagIds, tagId];
      return { selectedTagIds: next, selectedIds: new Set(), focusId: null, lastClickedId: null };
    }),
  clearTagFilters: () => set({ selectedTagIds: [], selectedIds: new Set(), focusId: null, lastClickedId: null }),
  setGroups: (groups) => set({ groups }),
  setTags: (tags) => set({ tags }),

  // 搜索历史
  addSearchHistory: (kw) => {
    if (!kw.trim()) return;
    set((s) => {
      const filtered = s.searchHistory.filter((h) => h !== kw);
      const next = [kw, ...filtered].slice(0, 20); // 最多保留 20 条
      // 不能空 catch：配额满 / 隐私模式下写入会失败，搜索历史悄悄不落盘，
      // 用户只看到"重启后历史没了"而无从查起。失败不影响当前会话，所以只警告不抛。
      try { localStorage.setItem("searchHistory", JSON.stringify(next)); } catch { logger.warn("搜索历史写入 localStorage 失败"); }
      return { searchHistory: next };
    });
  },
  removeSearchHistory: (kw) => {
    set((s) => {
      const next = s.searchHistory.filter((h) => h !== kw);
      try { localStorage.setItem("searchHistory", JSON.stringify(next)); } catch { logger.warn("搜索历史写入 localStorage 失败"); }
      return { searchHistory: next };
    });
  },
  clearSearchHistory: () => {
    try { localStorage.setItem("searchHistory", "[]"); } catch { logger.warn("清空搜索历史写入 localStorage 失败"); }
    set({ searchHistory: [] });
  },

  // 选择
  selectItem: (id, multi = false, range = false) =>
    set((s) => {
      if (multi || range) {
        // 多选 / 范围选择：操作 selectedIds
        const newIds = new Set(s.selectedIds);
        if (range && s.lastClickedId) {
          const items = s.getFilteredItems();
          const lastIdx = items.findIndex((i) => i.id === s.lastClickedId);
          const curIdx = items.findIndex((i) => i.id === id);
          if (lastIdx >= 0 && curIdx >= 0) {
            const [start, end] = [Math.min(lastIdx, curIdx), Math.max(lastIdx, curIdx)];
            for (let i = start; i <= end; i++) {
              newIds.add(items[i].id);
            }
          }
        } else {
          // Ctrl+点击：切换选中
          if (newIds.has(id)) newIds.delete(id);
          else newIds.add(id);
        }
        return { selectedIds: newIds, focusId: id, lastClickedId: id };
      }
      // 修复 U12：普通点击时若存在多选，先清空选中（提供直觉的取消出口），再设置焦点
      return {
        selectedIds: s.selectedIds.size > 0 ? new Set() : s.selectedIds,
        focusId: id,
        lastClickedId: id,
      };
    }),
  clearSelection: () => set({ selectedIds: new Set(), focusId: null, lastClickedId: null }),
  selectAll: () =>
    set((s) => {
      const items = s.getFilteredItems();
      return { selectedIds: new Set(items.map((i) => i.id)) };
    }),

  setSeqPointer: (p) => set({ seqPointer: p }),
  resetSeqPointer: () => set({ seqPointer: 0 }),
  setPaused: (p) => set({ paused: p }),

  // 剪贴板栈
  setStackMode: (active) =>
    set(
      active
        ? { stackMode: true, stackItems: [], stackDoneIds: new Set(), stackPasted: 0, stackCollected: 0 }
        : { stackMode: false }
    ),
  stackPush: (item) =>
    set((s) => {
      if (!s.stackMode) return s;
      // 去重：与栈顶真实内容完全相同则跳过（文本比 text，图片/文件比 content 路径）
      const top = s.stackItems[0];
      const keyOf = (it: HistoryItem) => (it.type === "text" ? it.text : it.content || it.text);
      if (top && top.type === item.type && keyOf(top) === keyOf(item)) return s;
      // 上限 50 条，超出移出最早的（栈底）；stackCollected 记录真实收集总数（不受截断影响）
      const next = [item, ...s.stackItems].slice(0, 50);
      return { stackItems: next, stackCollected: s.stackCollected + 1 };
    }),
  stackMarkPasted: () =>
    set((s) => {
      if (s.stackItems.length === 0) return s;
      const [pasted, ...rest] = s.stackItems;
      const done = new Set(s.stackDoneIds);
      done.add(pasted.id);
      // 若这一条属于最近一次表格拆分，说明部分内容已经贴出去了——此时如果还允许「撤销拆分」，会把整张原表重新塞回队列，
      // 导致已经贴过的部分被重复粘贴一次，所以要把可撤销记录一并清掉
      const stillUndoable = s.stackLastSplit && !s.stackLastSplit.itemIds.includes(pasted.id);
      return {
        stackItems: rest,
        stackDoneIds: done,
        stackPasted: s.stackPasted + 1,
        stackLastSplit: stillUndoable ? s.stackLastSplit : null,
      };
    }),
  // 拖拽重排：直接复用 quickOrder.ts 的 reorderAction（id 数组换位纯函数），不再另写一份
  stackReorder: (fromId, toId) =>
    set((s) => {
      if (!s.stackMode) return s;
      const ids = s.stackItems.map((i) => i.id);
      const fromIdx = ids.indexOf(fromId);
      const toIdx = ids.indexOf(toId);
      if (fromIdx < 0 || toIdx < 0) return s;
      const nextIds = reorderAction(ids, fromIdx, toIdx);
      if (!nextIds) return s;
      const byId = new Map(s.stackItems.map((i) => [i.id, i]));
      return { stackItems: nextIds.map((id) => byId.get(id)!) };
    }),
  // 删除角标：仅从未粘贴队列移除，不影响 stackCollected/stackDoneIds/stackPasted 的历史统计
  stackRemoveItem: (id) =>
    set((s) => {
      if (!s.stackMode) return s;
      const next = s.stackItems.filter((i) => i.id !== id);
      if (next.length === s.stackItems.length) return s;
      return { stackItems: next };
    }),
  toggleStackTabAdvance: () => set((s) => ({ stackTabAdvance: !s.stackTabAdvance })),
  stackLoadTemplate: (items) =>
    set((s) => {
      const now = new Date().toISOString();
      const loaded: HistoryItem[] = items.map((it) => ({
        id: crypto.randomUUID(),
        text: it.text,
        time: now,
        type: it.type,
        content: it.content,
        pinned: false,
        source: "template",
        workspace: s.config.current_workspace,
      }));
      return {
        stackMode: true,
        stackItems: loaded,
        stackCollected: s.stackCollected + loaded.length,
      };
    }),
  // 表格拆分：检测只对文本/图文类型做，命中则逐行拆分入栈（不登记进 history，避免连带触发只该由真实剪贴板事件产生的副作用）；
  // 未命中时降级为普通整条入栈，与现有行为完全一致。
  stackPushOrSplit: (item) => {
    const s = get();
    if (!s.stackMode) return null;
    if (s.config.table_split_enabled && (item.type === "text" || item.type === "rich")) {
      const split = splitTableToRows(item.text || "", {
        format: s.config.table_split_format,
        includeHeader: s.config.table_split_include_header,
      });
      if (split && split.rows.length > 0) {
        // 注意：不能逐行调 stackPush 循环推入——它两个行为都不适合批量拆分场景：
        // ① 头插会把最后逐行 push 的行顶到最前面，与表格原始顺序相反；
        // ② 它的去重只比当前栈顶，循环里每 push 一行栈顶就变了，表格里相邻两行完全相同时会被静默吸掉。
        // 直接构造好整批按表格顺序的条目一次性 set()，两个问题同时解决。
        const now = new Date().toISOString();
        const newItems: HistoryItem[] = split.rows.map((rowText) => ({
          id: crypto.randomUUID(),
          text: rowText,
          time: now,
          type: "text",
          content: "",
          pinned: false,
          source: item.source,
          workspace: s.config.current_workspace,
        }));
        set((s2) => ({
          stackItems: [...newItems, ...s2.stackItems].slice(0, 50),
          stackCollected: s2.stackCollected + newItems.length,
          stackLastSplit: { originalText: item.text, itemIds: newItems.map((i) => i.id) },
        }));
        return { splitCount: split.rows.length, totalRows: split.totalRows };
      }
    }
    get().stackPush(item);
    return null;
  },
  stackUndoSplit: () =>
    set((s) => {
      const last = s.stackLastSplit;
      if (!last) return s;
      const idSet = new Set(last.itemIds);
      const remaining = s.stackItems.filter((i) => !idSet.has(i.id));
      if (remaining.length === s.stackItems.length) return { stackLastSplit: null };
      const restored: HistoryItem = {
        id: crypto.randomUUID(),
        text: last.originalText,
        time: new Date().toISOString(),
        type: "text",
        content: "",
        pinned: false,
        source: "clipboard",
        workspace: s.config.current_workspace,
      };
      return { stackItems: [restored, ...remaining], stackLastSplit: null };
    }),
  stackConsumeMerged: (ids) =>
    set((s) => {
      const idSet = new Set(ids);
      const consumed = s.stackItems.filter((i) => idSet.has(i.id));
      if (consumed.length === 0) return s;
      const remaining = s.stackItems.filter((i) => !idSet.has(i.id));
      const done = new Set(s.stackDoneIds);
      consumed.forEach((i) => done.add(i.id));
      return { stackItems: remaining, stackDoneIds: done, stackPasted: s.stackPasted + consumed.length };
    }),
  exitStackMode: () =>
    set({ stackMode: false, stackItems: [], stackDoneIds: new Set(), stackPasted: 0, stackCollected: 0, stackPasteAllActive: false, stackLastSplit: null }),

  // 来源图标缓存
  setRealIconUrl: (key, url) => set((s) => ({
    realIconCache: { ...s.realIconCache, [key]: url },
  })),

  // 配置
  updateConfig: (partial) => {
    // 兼容旧配置：hover_preview_enabled → hover_mode
    const clean = { ...partial };
    if ("hover_preview_enabled" in clean) {
      clean.hover_mode = clean.hover_preview_enabled ? "popover" : "off";
      delete clean.hover_preview_enabled;
    }
    // 修复 Low（Zustand 反模式）：副作用（动态 import + 事件派发）移出 set updater，
    // updater 保持纯函数；先读旧工作区，set 之后再触发缓存失效
    const prevWorkspace = get().config.current_workspace;
    set((s) => ({ config: { ...s.config, ...clean } }));
    if (clean.current_workspace && clean.current_workspace !== prevWorkspace) {
      import("@/lib/api").then(m => m.invalidateCountsCache()).catch(() => {});
    }
  },

  // 计算属性（带简单缓存避免频繁计算）
  _filterCache: null as { key: string; result: HistoryItem[] } | null,
  getFilteredItems: () => {
    // 搜索模式：关键词激活时优先返回后端全量搜索结果（已覆盖未加载的记录），
    // 不再 filter 分页加载的内存窗口。结果尚未写回（首次搜索进行中）时，
    // 先落在下方的内存窗口过滤作为过渡占位（App.tsx effect 写回后即被完整结果替换）；
    // 这也让无后端的纯 store 单测能继续验证搜索过滤逻辑。
    if (get().searchKeyword.trim()) {
      const sr = get().searchResults;
      if (sr !== null) return sr;
    }

    const { history, historyVersion, searchKeyword, filterType, timeFilter, sourceFilter, groupFilter, selectedTagIds, config } = get();
    // 生成缓存键（用 historyVersion 而非 history.length：长度不变的变更如置顶也能正确失效）
    const cacheKey = `${historyVersion}|${searchKeyword}|${filterType}|${timeFilter}|${sourceFilter}|${groupFilter}|${selectedTagIds.join(",")}|${config.current_workspace}`;
    const s = get();
    if (s._filterCache && s._filterCache.key === cacheKey) {
      return s._filterCache.result;
    }

    const ws = config.current_workspace;
    const kw = searchKeyword ? searchKeyword.toLowerCase() : "";
    const now = Date.now();

    // 预计算时间截止线
    let cutoff = 0;
    if (timeFilter !== "all") {
      const msInDay = 86400000;
      if (timeFilter === "today") {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        cutoff = startOfDay.getTime();
      } else if (timeFilter === "week") {
        cutoff = now - 7 * msInDay;
      } else if (timeFilter === "month") {
        cutoff = now - 30 * msInDay;
      }
    }

    // 单次遍历：合并 workspace + 搜索 + 类型 + 时间 + 来源 + 分组 + 标签过滤
    const items: HistoryItem[] = [];
    for (let i = 0; i < history.length; i++) {
      const h = history[i];

      // 工作区过滤
      if (h.workspace !== ws) continue;

      // 搜索过滤（文本 + 拼音 + 内容路径）
      // U41：图片项 text 为"[图片] WxH"、文件名在 content 路径里；文件项完整路径也在 content，
      //      因此一并匹配 content，让图片文件名 / 文件路径可被搜到
      if (kw) {
        if (!h.text.toLowerCase().includes(kw) &&
            !(h.pinyin_initials && h.pinyin_initials.toLowerCase().includes(kw)) &&
            !(h.content && h.content.toLowerCase().includes(kw))) {
          continue;
        }
      }

      // 类型过滤
      if (filterType === "pinned") {
        if (!h.pinned) continue;
      } else if (filterType === "image") {
        // 图文混排归入「图片」：口径必须与后端 get_history 一致，
        // 否则前端本地过滤与后端分页查询会给出不同结果
        if (h.type !== "image" && h.type !== "rich") continue;
      } else if (filterType !== "all") {
        if (h.type !== filterType) continue;
      }

      // 时间范围过滤
      if (cutoff > 0) {
        // 懒计算 timeStamp（只对需要的项计算一次）
        if (h.timeStamp === undefined) {
          h.timeStamp = new Date(h.time.replace(" ", "T")).getTime();
        }
        if (h.timeStamp < cutoff) continue;
      }

      // 来源过滤
      if (sourceFilter && h.source !== sourceFilter) continue;

      // 分组过滤
      if (groupFilter === "ungrouped") {
        if (h.group_id) continue;
      } else if (groupFilter !== "all") {
        if (h.group_id !== groupFilter) continue;
      }

      // 标签过滤（AND 逻辑）
      if (selectedTagIds.length > 0) {
        const itemTagIds = (h.tags || []).map((t) => t.id);
        if (!selectedTagIds.every((tid) => itemTagIds.includes(tid))) continue;
      }

      items.push(h);
    }

    // 排序：置顶在前，按时间倒序（使用预计算的 timeStamp）
    items.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      // 懒计算 timeStamp
      if (a.timeStamp === undefined) a.timeStamp = new Date(a.time.replace(" ", "T")).getTime();
      if (b.timeStamp === undefined) b.timeStamp = new Date(b.time.replace(" ", "T")).getTime();
      return b.timeStamp - a.timeStamp;
    });

    // 缓存结果
    get()._filterCache = { key: cacheKey, result: items };
    return items;
  },

  getSelectedItems: () => {
    const { history, selectedIds } = get();
    return history.filter((h) => selectedIds.has(h.id));
  },
}));
