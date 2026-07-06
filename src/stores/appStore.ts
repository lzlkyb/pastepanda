import { create } from "zustand";

// ===== 数据类型 =====

export interface Tag {
  id: string;
  name: string;
  color: string;
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
  type: "text" | "image" | "file";
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
}

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
}

// ===== Store 接口 =====

interface AppState {
  // 数据
  history: HistoryItem[];
  config: AppConfig;
  groups: Group[];
  tags: Tag[];

  // UI 状态
  searchKeyword: string;
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

  // 动作
  setHistory: (items: HistoryItem[]) => void;
  appendHistory: (items: HistoryItem[]) => void;
  prependItem: (item: HistoryItem) => void;
  moveToTop: (id: string, newTime: string) => void;
  removeItems: (ids: string[]) => void;
  undoDelete: () => HistoryItem[] | null;
  togglePin: (id: string) => void;
  reorderItems: (fromId: string, toId: string) => void;
  clearAll: () => void;

  setSearchKeyword: (kw: string) => void;
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

  updateConfig: (partial: Partial<AppConfig>) => void;

  // 计算属性（带缓存）
  _filterCache: { key: string; result: HistoryItem[] } | null;
  getFilteredItems: () => HistoryItem[];
  getSelectedItems: () => HistoryItem[];
}

// ===== 默认配置 =====

const DEFAULT_CONFIG: AppConfig = {
  hotkey: "ctrl+shift+v",
  theme: "light",
  auto_cleanup_days: 30,
  auto_strip: false,
  sequential_loop: false,
  hide_on_focus_out: true,
  lan_sync_enabled: false,
  always_on_top: false,
  auto_startup: false,
  sequential_hotkey: "ctrl+q",
  select_all_hotkey: "ctrl+a",
  current_workspace: "默认",
  workspaces: ["默认"],
  double_click_action: "preview",
  hover_mode: "popover",
};

// ===== Store =====

export const useAppStore = create<AppState>((set, get) => ({
  // 数据
  history: [],
  config: DEFAULT_CONFIG,
  groups: [],
  tags: [],

  // UI 状态
  searchKeyword: "",
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
  searchHistory: (() => {
    try {
      const saved = localStorage.getItem("searchHistory");
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  })(),

  // 数据操作
  setHistory: (items) => set({ history: items }),
  appendHistory: (items) => set((s) => ({ history: [...s.history, ...items] })),
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
        return { history: [updated, ...s.history.slice(0, dupIdx), ...s.history.slice(dupIdx + 1)] };
      }
      // 限制前端缓存最大 500 条，防止内存泄漏
      if (s.history.length >= 500) {
        return { history: [item, ...s.history.slice(0, 499)] };
      }
      return { history: [item, ...s.history] };
    }),
  // 智能合并：将已有记录移到顶部并更新时间
  moveToTop: (id: string, newTime: string) =>
    set((s) => {
      const idx = s.history.findIndex((h) => h.id === id);
      if (idx < 0) return s;
      const item = { ...s.history[idx], time: newTime };
      const newHistory = [item, ...s.history.slice(0, idx), ...s.history.slice(idx + 1)];
      return { history: newHistory };
    }),
  removeItems: (ids) =>
    set((s) => {
      const idSet = new Set(ids);
      const deleted = s.history.filter((h) => idSet.has(h.id));
      return {
        history: s.history.filter((h) => !idSet.has(h.id)),
        selectedIds: new Set([...s.selectedIds].filter((id) => !idSet.has(id))),
        focusId: s.focusId && idSet.has(s.focusId) ? null : s.focusId,
        undoStack: [deleted, ...s.undoStack].slice(0, 10),
      };
    }),
  undoDelete: () => {
    const s = get();
    if (s.undoStack.length === 0) return null;
    const [restored, ...rest] = s.undoStack;
    set({
      history: [...restored, ...s.history],
      undoStack: rest,
    });
    return restored;
  },
  togglePin: (id) =>
    set((s) => {
      s._filterCache = null; // 清除缓存确保列表刷新
      return {
        history: s.history.map((h) =>
          h.id === id ? { ...h, pinned: !h.pinned } : h
        ),
      };
    }),
  // 拖拽排序：将 fromId 移动到 toId 之前（在原始 history 中操作，不改变置顶排序）
  reorderItems: (fromId: string, toId: string) =>
    set((s) => {
      const fromIdx = s.history.findIndex((h) => h.id === fromId);
      const toIdx = s.history.findIndex((h) => h.id === toId);
      if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return s;
      const newHistory = [...s.history];
      const [moved] = newHistory.splice(fromIdx, 1);
      newHistory.splice(toIdx, 0, moved);
      return { history: newHistory };
    }),
  clearAll: () => set({ history: [], selectedIds: new Set(), focusId: null }),

  // 搜索/筛选（防抖已在 TopBar 中处理，此处直接同步更新）
  setSearchKeyword: (kw) => {
    set({ searchKeyword: kw, selectedIds: new Set(), focusId: null, lastClickedId: null });
  },
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
      try { localStorage.setItem("searchHistory", JSON.stringify(next)); } catch {}
      return { searchHistory: next };
    });
  },
  removeSearchHistory: (kw) => {
    set((s) => {
      const next = s.searchHistory.filter((h) => h !== kw);
      try { localStorage.setItem("searchHistory", JSON.stringify(next)); } catch {}
      return { searchHistory: next };
    });
  },
  clearSearchHistory: () => {
    try { localStorage.setItem("searchHistory", "[]"); } catch {}
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
      // 普通点击：只设置焦点，不清空多选（保留已多选的项）
      return { focusId: id, lastClickedId: id };
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

  // 配置
  updateConfig: (partial) => {
    // 兼容旧配置：hover_preview_enabled → hover_mode
    const clean = { ...partial };
    if ("hover_preview_enabled" in clean) {
      clean.hover_mode = clean.hover_preview_enabled ? "popover" : "off";
      delete clean.hover_preview_enabled;
    }
    set((s) => {
      // 工作区切换 → 清除计数缓存（让 TopBar 重新查后端）
      if (clean.current_workspace && clean.current_workspace !== s.config.current_workspace) {
        import("@/lib/api").then(m => m.invalidateCountsCache()).catch(() => {});
      }
      return { config: { ...s.config, ...clean } };
    });
  },

  // 计算属性（带简单缓存避免频繁计算）
  _filterCache: null as { key: string; result: HistoryItem[] } | null,
  getFilteredItems: () => {
    const { history, searchKeyword, filterType, timeFilter, sourceFilter, groupFilter, selectedTagIds, config } = get();
    // 生成缓存键
    const cacheKey = `${history.length}|${searchKeyword}|${filterType}|${timeFilter}|${sourceFilter}|${groupFilter}|${selectedTagIds.join(",")}|${config.current_workspace}`;
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

      // 搜索过滤（文本 + 拼音）
      if (kw) {
        if (!h.text.toLowerCase().includes(kw) &&
            !(h.pinyin_initials && h.pinyin_initials.toLowerCase().includes(kw))) {
          continue;
        }
      }

      // 类型过滤
      if (filterType === "pinned") {
        if (!h.pinned) continue;
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
