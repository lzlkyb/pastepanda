import { useEffect, useState, useCallback, useRef, lazy, Suspense, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { applyTheme, DEFAULT_THEME, ThemeKey } from "@/lib/theme";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, HistoryItem, buildSearchKey } from "@/stores/appStore";
import { useDialogStore, anyDialogOpen } from "@/stores/dialogStore";
import { TopBar } from "@/components/TopBar";
import { SuggestionBar } from "@/components/SuggestionBar";
import { AiQuickBar } from "@/components/AiQuickBar";
import { useAiStatus } from "@/hooks/useAiStatus";
import { aiAwarenessActive } from "@/lib/aiAwareness";
import { CardList } from "@/components/CardList";
import { QuickPreview } from "@/components/QuickPreview";
import { SkinScene } from "@/components/SkinScene";
import { useToast } from "@/components/Toast";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { UpdateProvider, useUpdate } from "@/contexts/UpdateContext";
import { useFirstTimeTip } from "@/hooks/useFirstTimeTip";
import { logger } from "@/lib/logger";
import { pasteTextGuarded, pasteImage, pasteRichGuarded, deleteHistory, togglePin, toggleWindow, saveForeground, invalidateCountsCache, createGroup, updateGroup, deleteGroup as deleteGroupApi, moveToGroup, fetchSidebarCounts, searchHistory, type SidebarCounts } from "@/lib/api";
import { resolveSource, getAutoTagIcon, getAutoTagColor } from "@/lib/source-mappings";
import { migrateLegacyStorageKeys } from "@/lib/storageMigration";
import { initRegexRules } from "@/lib/regexRules";
import { parseDiagram, diagramTitle } from "@/lib/diagram/types";
import { Loader2, X, Heart } from "lucide-react";
import { BackToTop } from "@/components/BackToTop";
import { ScrollProvider } from "@/contexts/ScrollContext";
import { Sidebar, type SidebarGroup } from "@/components/Sidebar";
import type Lenis from "lenis";
import appStyles from "./App.module.css";
import { FocusTrap } from "@/components/FocusTrap";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ConfirmDialogHost } from "@/components/ConfirmDialogHost";
import { useDialogAnim } from "@/lib/dialogMotion";

// 修复 Low：应用更名后迁移历史版本遗留的 pasteship_* localStorage 键（幂等，仅执行一次）
migrateLegacyStorageKeys();

// 懒加载对话框组件 — 只在打开时才加载对应 JS chunk
const SettingsDialog = lazy(() => import("@/components/SettingsDialog").then(m => ({ default: m.SettingsDialog })));
const PinnedPanel = lazy(() => import("@/components/PinnedPanel"));
const SnippetsDialog = lazy(() => import("@/components/SnippetsDialog").then(m => ({ default: m.SnippetsDialog })));
const ExtractDialog = lazy(() => import("@/components/ExtractDialog").then(m => ({ default: m.ExtractDialog })));
const EncodingDialog = lazy(() => import("@/components/EncodingDialog").then(m => ({ default: m.EncodingDialog })));
const BatchReplaceDialog = lazy(() => import("@/components/BatchReplaceDialog").then(m => ({ default: m.BatchReplaceDialog })));
const ConfigDiffDialog = lazy(() => import("@/components/ConfigDiffDialog").then(m => ({ default: m.ConfigDiffDialog })));
const SequentialPasteDialog = lazy(() => import("@/components/SequentialPasteDialog").then(m => ({ default: m.SequentialPasteDialog })));
const UpdateNotesDialog = lazy(() => import("@/components/UpdateNotesDialog").then(m => ({ default: m.UpdateNotesDialog })));

function App() {
  const config = useAppStore((s) => s.config);
  const history = useAppStore((s) => s.history);
  const groups = useAppStore((s) => s.groups);
  const tags = useAppStore((s) => s.tags);
  const resetSeqPointer = useAppStore((s) => s.resetSeqPointer);
  const sourceFilter = useAppStore((s) => s.sourceFilter);
  const setSourceFilter = useAppStore((s) => s.setSourceFilter);
  const groupFilter = useAppStore((s) => s.groupFilter);
  const setGroupFilter = useAppStore((s) => s.setGroupFilter);
  const filterType = useAppStore((s) => s.filterType);
  const searchKeyword = useAppStore((s) => s.searchKeyword);
  const timeFilter = useAppStore((s) => s.timeFilter);
  const selectedTagIds = useAppStore((s) => s.selectedTagIds);
  const workspace = useAppStore((s) => s.config.current_workspace);
  const historyVersion = useAppStore((s) => s.historyVersion);
  const setSearchResults = useAppStore((s) => s.setSearchResults);
  const setSearchLoading = useAppStore((s) => s.setSearchLoading);
  const { toast } = useToast();
  const anim = useDialogAnim();

  /** 新建流程图：写入空文档到历史库，再直接打开全屏编辑器 */
  const handleNewDiagram = useCallback(() => {
    const ws = workspace || "默认";
    const content = JSON.stringify({ version: 1, nodes: [], edges: [] });
    invoke<string>("insert_diagram_history", { content, text: diagramTitle(parseDiagram(content)), workspace: ws })
      .then((id) => {
        invoke("open_fullscreen_editor", { sourceId: id, content, contentType: "diagram", language: null }).catch(() => {});
      })
      .catch((e) => {
        logger.error("新建流程图失败", e);
        toast("新建流程图失败：" + String(e), "error");
      });
  }, [workspace, toast]);
  const [showSettings, setShowSettings] = useState(false);
  /** v6.19 贴图管理面板（托盘"贴图管理"→ show-pinned-panel 事件打开） */
  const [showPinnedPanel, setShowPinnedPanel] = useState(false);
  /** v6.4 审查：#10 从变换中心跳转时指定初始 tab（"ai"） */
  const [showSettingsTab, setShowSettingsTab] = useState<"general" | "ai" | "help" | "about" | undefined>(undefined);
  /** v6.4 方案 B：AI 快捷区开关（AI **真能用**时才替代建议条；三态见 @/lib/aiAvailability） */
  const { status: aiStatus } = useAiStatus();
  /** v6.4 引导期：AI 感知 UI 只在「本版本更新后 1 周」显示，之后自动隐藏（不长期占顶部空间） */
  const [appVersion, setAppVersion] = useState("");
  // aiAwarenessActive 有 localStorage 写副作用，不能在 render 期调用（审查 backlog）——放到 effect
  const [aiAwareActive, setAiAwareActive] = useState(false);
  useEffect(() => {
    import("@/lib/api").then((m) => m.getAppVersion().then(setAppVersion)).catch(() => {});
  }, []);
  useEffect(() => {
    if (appVersion) setAiAwareActive(aiAwarenessActive(appVersion));
  }, [appVersion]);
  // 审查 #1（学习回流）：监听动作事件 → debounce 刷新推荐权重（会话内学习可见）
  useEffect(() => {
    void import("@/lib/recommend").then((m) => m.initLearnListener());
  }, []);
  // Phase 3 闭环入口：markdown 卡片里的 mermaid「编辑」按钮 → 解析成图 → 写入历史库 → 开全屏编辑器
  useEffect(() => {
    const onMermaidEdit = (e: Event) => {
      const source = (e as CustomEvent<{ source: string }>).detail?.source || "";
      if (!source.trim()) return;
      const ws = workspace || "默认";
      void import("@/lib/diagram/types").then(({ parseMermaid, serializeDiagram }) => {
        const content = serializeDiagram(parseMermaid(source));
        invoke<string>("insert_diagram_history", { content, text: diagramTitle(parseDiagram(content)), workspace: ws })
          .then((id) =>
            invoke("open_fullscreen_editor", { sourceId: id, content, contentType: "diagram", language: null }),
          )
          .catch((err) => {
            logger.error("mermaid 编辑失败", err);
            toast("打开流程图编辑失败：" + String(err), "error");
          });
      });
    };
    window.addEventListener("pp:mermaid-edit", onMermaidEdit);
    return () => window.removeEventListener("pp:mermaid-edit", onMermaidEdit);
  }, [workspace, toast]);
  const [showSequential, setShowSequential] = useState(false);
  const [showSnippets, setShowSnippets] = useState(false);
  const [showExtract, setShowExtract] = useState(false);
  const [showEncoding, setShowEncoding] = useState(false);
  const [showBatchReplace, setShowBatchReplace] = useState(false);
  const [showConfigDiff, setShowConfigDiff] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeGroupId, setActiveGroupId] = useState("all");
  const [moveToGroupItem, setMoveToGroupItem] = useState<HistoryItem | null>(null);
  const retryCleanupRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lenisRef = useRef<Lenis | null>(null);
  const sidebarOpenRef = useRef(false);

  useEffect(() => {
    try { applyTheme((config.theme as ThemeKey) || DEFAULT_THEME); } catch (e) { logger.warn("应用主题失败", e); }
  }, [config.theme]);

  // 窗口置顶状态恢复
  useEffect(() => {
    import("@tauri-apps/api/window").then(m => m.getCurrentWindow().setAlwaysOnTop(config.always_on_top)).catch(e => logger.warn("窗口置顶设置失败", e));
  }, [config.always_on_top]);

  // 修复 U15：筛选条件变化时重置依次粘贴指针，避免计数与遍历目标脱节
  const filterKey = `${searchKeyword}|${filterType}|${timeFilter}|${sourceFilter}|${groupFilter}|${selectedTagIds.join(",")}|${workspace}`;
  const isFirstFilterRef = useRef(true);
  useEffect(() => {
    if (isFirstFilterRef.current) { isFirstFilterRef.current = false; return; }
    resetSeqPointer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  // 监听来自 api.ts 的 toast 通知（如自动清理）和首次提示
  useEffect(() => {
    const toastHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.message) toast(detail.message, detail.type || "info", undefined, undefined, undefined, detail.copyText);
    };
    const moveToGroupHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.item) {
        setMoveToGroupItem(detail.item);
      }
    };
    window.addEventListener("app-toast", toastHandler);
    window.addEventListener("first-time-tip", toastHandler);
    window.addEventListener("app-move-to-group", moveToGroupHandler);
    return () => {
      window.removeEventListener("app-toast", toastHandler);
      window.removeEventListener("first-time-tip", toastHandler);
      window.removeEventListener("app-move-to-group", moveToGroupHandler);
    };
     
  }, [toast]);

  // 组件卸载时清理 retry 创建的监听器
  useEffect(() => {
    return () => { if (retryCleanupRef.current) retryCleanupRef.current(); };
  }, []);





  // 失焦自动隐藏（弹窗打开时跳过）—— 使用 useRef 避免闭包陷阱
  const dialogOpen = showSettings || showSequential || showSnippets || showExtract || showEncoding || showBatchReplace || showConfigDiff;
  const dialogOpenRef = useRef(dialogOpen);
  dialogOpenRef.current = dialogOpen;

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    let hideTimer: number | null = null;
    async function setup() {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        // Tauri 2: 使用 onFocusChanged 替代已移除的 tauri://focus-lost 事件
        const fn = await win.onFocusChanged(({ payload: focused }) => {
          if (focused) {
            // 重新获焦时取消任何 pending hide
            if (hideTimer !== null) { window.clearTimeout(hideTimer); hideTimer = null; }
            return;
          }
          // 失焦即刷新粘贴目标：把刚切到的应用存为"粘贴到前台"的目标窗口。
          // 必须无条件执行（不依赖 hide_on_focus_out），否则主窗口常驻期间保存值
          // 一直停留在"打开窗口时"的旧目标；Rust 侧已排除自身窗口与桌面，不会误覆盖。
          saveForeground().catch(() => {});
          const cfg = useAppStore.getState().config;
          if (!cfg.hide_on_focus_out || dialogOpenRef.current) return;
          // 防抖 150ms：避免弹窗切换/菜单闪烁期间的瞬时失焦误触发
          if (hideTimer !== null) window.clearTimeout(hideTimer);
          hideTimer = window.setTimeout(() => {
            hideTimer = null;
            // 二次检查：仍处于失焦状态才隐藏
            if (dialogOpenRef.current) return;
            win.hide().catch(e => logger.warn("隐藏窗口失败", e));
          }, 150);
        });
        if (cancelled) {
          // effect 已在本次 setup 完成前被清理（StrictMode 重挂载 / HMR），立即取消订阅，避免监听器泄漏
          fn();
        } else {
          unlisten = fn;
        }
      } catch (e) { logger.warn("注册失焦监听失败", e); }
    }
    setup();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      if (hideTimer !== null) { window.clearTimeout(hideTimer); hideTimer = null; }
    };
  }, []);

  // 侧边栏聚合计数（后端 GROUP BY 全量统计）— 不再依赖内存分页窗口。
  // 此前直接 filter 已加载窗口（初始 50 条、上限 500 条）：计数随滚动变化、
  // 未加载的来源/分类不显示、与 TopBar 的 DB 计数矛盾。
  // 挂在 counts-invalidated 事件上实时刷新（每次增删后触发，与 TopBar 同节奏）。
  const [sidebarCounts, setSidebarCounts] = useState<SidebarCounts | null>(null);
  useEffect(() => {
    let seq = 0;
    const refresh = () => {
      const my = ++seq;
      fetchSidebarCounts(config.current_workspace)
        .then(c => { if (my === seq) setSidebarCounts(c); })
        .catch(e => logger.warn("获取侧边栏计数失败", e));
    };
    refresh();
    window.addEventListener("counts-invalidated", refresh);
    return () => { seq++; window.removeEventListener("counts-invalidated", refresh); };
  }, [config.current_workspace]);

  // 搜索模式编排：关键词激活时按全部筛选条件查询后端（search_history 全量下推），
  // 结果写回 store.searchResults —— getFilteredItems 在搜索模式直接返回它，
  // 从而搜到尚未分页加载的记录（修复"搜索只覆盖已加载窗口"）。
  // 依赖涵盖全部筛选 + 工作区 + historyVersion：搜索期间的增删/置顶等数据变更也会刷新结果。
  // searchSeqRef 防竞态：筛选快速变化导致多个查询在飞时，只允许最新一次写回。
  const searchSeqRef = useRef(0);
  useEffect(() => {
    if (!searchKeyword.trim()) return; // 无关键词 → 非搜索模式（setSearchKeyword 已清空结果）
    const st = useAppStore.getState();
    const key = buildSearchKey(st);
    if (st.searchResults !== null && st.searchResultsKey === key) return; // 同查询结果已新鲜
    const seq = ++searchSeqRef.current;
    setSearchLoading(true);
    searchHistory({
      search: st.searchKeyword,
      filter: st.filterType,
      timeFilter: st.timeFilter,
      source: st.sourceFilter,
      groupFilter: st.groupFilter,
      tagIds: st.selectedTagIds,
    }).then((results) => {
      if (seq !== searchSeqRef.current) return; // 已被更新的查询取代
      setSearchResults(results, key);
    }).catch((e) => {
      if (seq !== searchSeqRef.current) return;
      logger.warn("全量搜索失败", e);
      setSearchResults([], key); // 失败返回空结果，避免 loading 悬挂
    });
  }, [searchKeyword, filterType, timeFilter, sourceFilter, groupFilter, selectedTagIds, workspace, historyVersion, setSearchResults, setSearchLoading]);

  // 侧边栏分组数据（计数全部来自后端聚合，前端只做名称清洗 + 图标映射 + 排序）
  const sidebarGroups = useMemo<SidebarGroup[]>(() => {
    // 内置分组：全部 + 收藏 + 未分组 + 截图（V6.19 截图图库）
    const shotCount = sidebarCounts?.sources.find((s) => s.source === "PastePanda 截图")?.count ?? 0;
    const builtin: SidebarGroup[] = [
      { id: "all", name: "全部", count: sidebarCounts?.total ?? 0, icon: "📋", isBuiltin: true, section: "builtin" as const },
      { id: "starred", name: "收藏", count: sidebarCounts?.pinned ?? 0, icon: "⭐", isBuiltin: true, section: "builtin" as const },
      { id: "ungrouped", name: "未分组", count: sidebarCounts?.ungrouped ?? 0, icon: "📂", isBuiltin: true, section: "builtin" as const },
      { id: "shots", name: "截图", count: shotCount, icon: "📸", isBuiltin: true, section: "builtin" as const },
    ];

    // 用户自定义分组
    const userGroupItems: SidebarGroup[] = groups.map(g => ({
      id: g.id,
      name: g.name,
      count: sidebarCounts?.groups[g.id] ?? 0,
      color: g.color,
      isBuiltin: false,
      isUserGroup: true,
      section: "user" as const,
    }));

    // 来源分组：后端按 source 聚合（已按计数降序），前端清洗名称 + 映射图标
    const dotColors = ["#3B82F6", "#22C55E", "#F97316", "#A855F7", "#EF4444", "#EC4899", "#14B8A6", "#F59E0B", "#6366F1"];
    const sourceGroups: SidebarGroup[] = (sidebarCounts?.sources ?? []).map((s, i) => {
      const resolved = resolveSource(s.source);
      return {
        id: `source:${s.source}`,
        name: resolved.displayName,
        count: s.count,
        icon: resolved.icon,
        color: dotColors[i % dotColors.length],
        isBuiltin: false,
        section: "source" as const,
        sourceRaw: s.source,
        sourceIcon: s.source_icon,
      };
    });

    // 智能分类分组：AI 自动标签（source="auto"）+ 后端标签计数
    const autoTags = tags.filter(t => t.source === "auto");
    const autoTagGroups: SidebarGroup[] = autoTags
      .map((t, i) => ({
        id: `auto:${t.id}`,
        name: t.name,
        count: sidebarCounts?.tags[t.id] ?? 0,
        icon: getAutoTagIcon(t.name),
        color: getAutoTagColor(t.name, i),
        isBuiltin: false,
        section: "auto" as const,
      }))
      .filter(g => g.count > 0)
      .sort((a, b) => b.count - a.count);

    return [...builtin, ...userGroupItems, ...sourceGroups, ...autoTagGroups];
  }, [sidebarCounts, groups, tags]);

  // 侧边栏分组点击 → 同步筛选状态
  const handleSelectGroup = useCallback((groupId: string) => {
    setActiveGroupId(groupId);
    if (groupId === "all") {
      setSourceFilter("");
      setGroupFilter("all");
      useAppStore.getState().setFilterType("all");
    } else if (groupId === "starred") {
      setSourceFilter("");
      setGroupFilter("all");
      useAppStore.getState().setFilterType("pinned");
    } else if (groupId === "ungrouped") {
      setSourceFilter("");
      useAppStore.getState().setFilterType("all");
      setGroupFilter("ungrouped");
    } else if (groupId === "shots") {
      // V6.19 截图图库：等价于按来源「PastePanda 截图」过滤（复用 source 查询链路）
      setGroupFilter("all");
      useAppStore.getState().setFilterType("all");
      setSourceFilter("PastePanda 截图");
    } else if (groupId.startsWith("source:")) {
      const source = groupId.slice(7);
      setGroupFilter("all");
      useAppStore.getState().setFilterType("all");
      setSourceFilter(source);
    } else if (groupId.startsWith("auto:")) {
      // AI 智能分类标签：切换标签筛选
      const tagId = groupId.slice(5);
      setSourceFilter("");
      setGroupFilter("all");
      useAppStore.getState().setFilterType("all");
      const store = useAppStore.getState();
      // 单选模式：替换当前标签筛选为该标签
      if (store.selectedTagIds.length === 1 && store.selectedTagIds[0] === tagId) {
        store.clearTagFilters();
      } else {
        store.clearTagFilters();
        store.toggleTagFilter(tagId);
      }
    } else {
      // 用户自定义分组 ID
      setSourceFilter("");
      useAppStore.getState().setFilterType("all");
      setGroupFilter(groupId);
    }
  }, [setSourceFilter, setGroupFilter]);

  // 分组操作回调
  const handleCreateGroup = useCallback(async (name: string, color: string, icon: string) => {
    const g = await createGroup(name, color, icon);
    if (g) {
      window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `已创建分组「${name}」`, type: "success" } }));
    } else {
      // 修复：创建失败时此前无任何提示，用户以为分组已建好，实际后端未写入
      window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `创建分组「${name}」失败`, type: "error" } }));
    }
     
  }, []);

  const handleRenameGroup = useCallback(async (id: string, name: string) => {
    const group = groups.find(g => g.id === id);
    if (!group) return;
    // 修复：重命名分组此前完全没有提示，成功/失败都补上
    const ok = await updateGroup(id, name, group.color, group.icon);
    window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: ok ? `已重命名为「${name}」` : "重命名分组失败", type: ok ? "success" : "error" } }));
  }, [groups]);

  // 修复：删除分组原本右键一点就直接删、无确认也不可撤销（对比删片段是有确认框的）。
  // 现先弹确认并告知影响面（该分组下有多少条记录），确认后才真删。
  const [deleteGroupTarget, setDeleteGroupTarget] = useState<{ id: string; name: string; count: number } | null>(null);

  const handleDeleteGroup = useCallback((id: string) => {
    const group = groups.find(g => g.id === id);
    if (!group) return;
    setDeleteGroupTarget({ id, name: group.name, count: sidebarCounts?.groups[id] ?? 0 });
  }, [groups, sidebarCounts]);

  const executeDeleteGroup = useCallback(async () => {
    const target = deleteGroupTarget;
    setDeleteGroupTarget(null);
    if (!target) return;
    // 修复：此前无论后端删除是否成功都弹"已删除"，现按真实返回值分别提示，避免假成功
    const ok = await deleteGroupApi(target.id);
    window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: ok ? `已删除分组「${target.name}」` : `删除分组「${target.name}」失败`, type: ok ? "info" : "error" } }));
  }, [deleteGroupTarget]);

  const handleChangeGroupColor = useCallback(async (id: string, color: string) => {
    const group = groups.find(g => g.id === id);
    if (!group) return;
    // 修复：修改分组颜色此前完全没有提示，成功/失败都补上
    const ok = await updateGroup(id, group.name, color, group.icon);
    window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: ok ? "已更新分组颜色" : "修改分组颜色失败", type: ok ? "success" : "error" } }));
  }, [groups]);

  // 移动到分组（api.ts 的 moveToGroup 接收 historyIds: string[]，返回实际移动条数）
  const handleMoveToGroup = useCallback(async (groupId: string | null) => {
    if (!moveToGroupItem) return;
    // 修复：此前无论后端返回什么都弹"已移动/已移除"成功提示，现按实际移动条数判断是否真的成功
    const count = await moveToGroup([moveToGroupItem.id], groupId);
    if (count > 0) {
      if (groupId) {
        const group = groups.find(g => g.id === groupId);
        window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `已移动到「${group?.name || groupId}」`, type: "success" } }));
      } else {
        window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: "已移除分组", type: "success" } }));
      }
    } else {
      window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: "移动分组失败", type: "error" } }));
    }
    setMoveToGroupItem(null);
  }, [moveToGroupItem, groups]);

  // 当筛选状态变化时，同步 activeGroupId（保持 Sidebar 高亮一致）
  useEffect(() => {
    if (filterType === "pinned") {
      setActiveGroupId("starred");
      return;
    }
    if (groupFilter === "ungrouped") {
      setActiveGroupId("ungrouped");
      return;
    }
    if (groupFilter && groupFilter !== "all") {
      setActiveGroupId(groupFilter);
      return;
    }
    // V6.19：截图图库高亮「📸 截图」内置项（而不是来源分组的同源项）
    if (sourceFilter === "PastePanda 截图") {
      setActiveGroupId("shots");
      return;
    }
    if (sourceFilter) {
      setActiveGroupId(`source:${sourceFilter}`);
      return;
    }
    setActiveGroupId("all");
  }, [sourceFilter, filterType, groupFilter]);

  // 侧边栏切换 — 纯 CSS transition，窗口宽度不变
  const toggleSidebar = useCallback(() => {
    const nextOpen = !sidebarOpenRef.current;
    sidebarOpenRef.current = nextOpen;
    setSidebarOpen(nextOpen);
  }, []);

  // 监听托盘菜单事件
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    let unlistenAi: (() => void) | null = null;
    let unlistenPin: (() => void) | null = null;
    let unlistenOcr: (() => void) | null = null;
    async function setup() {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        // 托盘"设置"菜单项 → 打开设置弹窗
        const fn = await listen("tray-open-settings", () => {
          setShowSettings(true);
        });
        // v6.4 审查：#10 变换中心预算超限 → 跳到设置 AI tab
        const fnAi = await listen("open-ai-settings", () => {
          setShowSettingsTab("ai");
          setShowSettings(true);
        });
        // v6.19 托盘"贴图管理" → 贴图管理面板
        const fnPin = await listen("show-pinned-panel", () => {
          setShowPinnedPanel(true);
        });
        // V6.19 截图复制后 → 主窗口提示"文字已识别"
        const fnOcr = await listen<{ text: string; count: number }>("screenshot-ocr-ready", (e) => {
          window.dispatchEvent(
            new CustomEvent("app-toast", {
              detail: {
                message: `📄 截图识别到 ${e.payload.count} 行文字 · 已存入剪贴板历史`,
                type: "success",
              },
            }),
          );
        });
        if (cancelled) {
          // effect 已在本次 setup 完成前被清理（StrictMode 重挂载 / HMR），立即取消订阅，避免监听器泄漏
          fn();
          fnAi();
          fnPin();
          fnOcr();
        } else {
          unlisten = fn;
          unlistenAi = fnAi;
          unlistenPin = fnPin;
          unlistenOcr = fnOcr;
        }
      } catch (e) { logger.warn("注册托盘事件监听失败", e); }
    }
    setup();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      if (unlistenAi) unlistenAi();
      if (unlistenPin) unlistenPin();
      if (unlistenOcr) unlistenOcr();
    };
  }, []);

  // 监听全局热键注册失败事件 — release 版无控制台，静默失败用户完全无感知，
  // 需在前端弹出提示，否则用户会以为软件坏了（常见于热键被微信/其他剪贴板工具/录屏软件占用）
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    async function setup() {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const fn = await listen<string>("hotkey-register-failed", (event) => {
          // 后端把所有失败绑定 join 成长串，这里只取数量做摘要，详情写日志
          const detail = event.payload || "";
          logger.warn("热键注册失败详情", detail);
          const count = detail ? detail.split(";").filter((s) => s.trim()).length : 0;
          const summary = count > 0 ? `${count} 个快捷键注册失败，可能已被其他程序占用` : "部分快捷键注册失败，可能已被其他程序占用";
          toast(summary, "error", 6000, () => setShowSettings(true), "去设置");
        });
        if (cancelled) {
          // effect 已在本次 setup 完成前被清理（StrictMode 重挂载 / HMR），立即取消订阅，避免监听器泄漏
          fn();
        } else {
          unlisten = fn;
        }
      } catch (e) { logger.warn("注册热键失败事件监听失败", e); }
    }
    setup();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
     
  }, [toast]);

  useEffect(() => {
    let cleanup: (() => void) | null = null;
    let mounted = true;
    async function init() {
      try {
        const { initBackend } = await import("@/lib/api");
        if (!mounted) return;
        cleanup = await initBackend();
        if (!mounted) {
          if (cleanup) cleanup();
          cleanup = null;
          return;
        }
        // 正则规则从 localStorage 迁移至 SQLite（首次运行）
        await initRegexRules();
      } catch (e) {
        logger.error("初始化后端失败", e);
        if (mounted) {
          setInitError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }
    init();
    return () => { 
      mounted = false; 
      if (cleanup) cleanup(); 
    };
  }, []);

  // 首次使用提示
  const { shouldShow, markShown } = useFirstTimeTip();
  const historyLenRef = useRef(history.length);
  useEffect(() => {
    // 首次有剪贴板内容时提示
    if (history.length > 0 && historyLenRef.current === 0 && !loading) {
      const timer = setTimeout(() => {
        if (shouldShow("first_copy")) {
          toast(`📋 已自动保存到 PastePanda，${config.hotkey || "Ctrl+Alt+V"} 随时唤出`, "success", 4000);
          markShown("first_copy");
        }
      }, 500);
      return () => clearTimeout(timer);
    }
    historyLenRef.current = history.length;
  }, [history.length, loading, shouldShow, markShown, toast, config.hotkey]);

  // 累计使用 3 天后提示依次粘贴功能
  useEffect(() => {
    if (loading) return;
    const timer = setTimeout(() => {
      if (shouldShow("seq_paste_tip")) {
        const daysSinceInstall = Number(localStorage.getItem("pastepanda_install_day") || 0);
        const now = Math.floor(Date.now() / 86400000);
        if (!daysSinceInstall) {
          localStorage.setItem("pastepanda_install_day", String(now));
        } else if (now - daysSinceInstall >= 3) {
          toast(`💡 试试 ${config.sequential_hotkey || "Ctrl+Alt+Q"} 依次粘贴，逐条粘贴超方便`, "info", 4000);
          markShown("seq_paste_tip");
        }
      }
    }, 10000); // 启动 10 秒后检查
    return () => clearTimeout(timer);
  }, [loading, shouldShow, markShown, toast, config.sequential_hotkey]);

  // 使用 ref 存储弹窗状态，避免 handleKeyDown 依赖变化导致频繁重新注册事件
  // U4：moveToGroup 弹窗一并登记，Esc/导航键守卫才能感知它
  const dialogStatesRef = useRef({ showSettings, showSequential, showSnippets, showExtract, showEncoding, showBatchReplace, showConfigDiff, showShortcuts, moveToGroup: !!moveToGroupItem });
  dialogStatesRef.current = { showSettings, showSequential, showSnippets, showExtract, showEncoding, showBatchReplace, showConfigDiff, showShortcuts, moveToGroup: !!moveToGroupItem };

  // U3：跟踪右键菜单开关（ContextMenu 打开/关闭时广播 app-ctxmenu-open/close 事件）
  const ctxMenuOpenRef = useRef(false);
  useEffect(() => {
    const onOpen = () => { ctxMenuOpenRef.current = true; };
    const onClose = () => { ctxMenuOpenRef.current = false; };
    window.addEventListener("app-ctxmenu-open", onOpen);
    window.addEventListener("app-ctxmenu-close", onClose);
    return () => {
      window.removeEventListener("app-ctxmenu-open", onOpen);
      window.removeEventListener("app-ctxmenu-close", onClose);
    };
  }, []);

  // U51：跟踪文件详情弹窗开关（由 CardList 管理，广播 app-filedetail-open/close 事件）
  const fileDetailOpenRef = useRef(false);
  useEffect(() => {
    const onOpen = () => { fileDetailOpenRef.current = true; };
    const onClose = () => { fileDetailOpenRef.current = false; };
    window.addEventListener("app-filedetail-open", onOpen);
    window.addEventListener("app-filedetail-close", onClose);
    return () => {
      window.removeEventListener("app-filedetail-open", onOpen);
      window.removeEventListener("app-filedetail-close", onClose);
    };
  }, []);

  // 键盘导航
  const handleKeyDown = useCallback(async (e: KeyboardEvent) => {
    // 忽略输入框内的按键
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    // U3：右键菜单打开期间所有按键让位给菜单（菜单自带方向键/Enter/Esc 处理），
    // 否则 Enter 会同时激活菜单项并粘贴选中卡片、Esc 会同时关菜单和隐藏窗口
    if (ctxMenuOpenRef.current) return;
    // 变换枢纽打开时同样让位（枢纽自带 ↑↓/Enter/Esc 处理）
    if (useDialogStore.getState().hubItem) return;
    // 弹窗打开时：ESC/? 正常工作，其余列表导航按键被屏蔽（让弹窗内部控件如 Tab 可以正常使用）
    const { showSettings, showSequential, showSnippets, showExtract, showEncoding, showBatchReplace, showConfigDiff, moveToGroup } = dialogStatesRef.current;
    // anyDialogOpen 覆盖 dialogStore 管的那批（卡片编辑弹框 / 链运行 / 粘贴守卫 / 画像 / 里程碑 …）。
    // 原先这里只手写了上面那串 show* 局部状态，漏掉了 store 那批：
    // 开着卡片编辑弹框按 Delete/Backspace 会直接删掉主窗口选中的卡片。
    const dialogOpen =
      showSettings || showSequential || showSnippets || showExtract || showEncoding ||
      showBatchReplace || showConfigDiff || moveToGroup || fileDetailOpenRef.current ||
      anyDialogOpen(useDialogStore.getState());
    const isListNavKey = ["ArrowDown", "ArrowUp", "Enter", "Delete", "Backspace", "Home", "End"].includes(e.key)
      || (e.ctrlKey && (e.key === "d" || e.key === "z" || e.key === "s" || e.key === "h" || e.key === "a"));
    if (dialogOpen && e.key !== "Escape" && e.key !== "?" && isListNavKey) return;

    const store = useAppStore.getState();
    const filtered = store.getFilteredItems();
    const selectedIds = store.selectedIds;
    const focusId = store.focusId;

    if (e.key === "Escape") {
      e.preventDefault();
      // U4：Esc 分层 — 关最上层弹窗 → 关分组弹窗 → 清多选 → 最后才隐藏窗口
      // 审查：store 型弹窗（dialogStore 管理）纳入分层且放最前——
      // 之前单独打开链运行器/粘贴守卫按 Esc 会直接隐藏整个窗口（全局兜底 toggleWindow），
      // 链运行器从枢纽打开时又被 hubItem 让位逻辑拦掉、无响应。
      const d = useDialogStore.getState();
      if (d.chainText) { d.closeChain(); return; }
      if (d.chainEdit) { d.closeChainEditor(); return; }
      if (d.pasteGuard) { d.closePasteGuard(); return; }
      if (d.profileOpen) { d.closeProfile(); return; }
      if (d.learningsOpen) { d.closeLearnings(); return; }
      if (d.editorItem) { return; } // 编辑器自带 Esc（含未保存确认），全局不抢；也不隐藏窗口
      if (showSettings) { setShowSettings(false); return; }
      if (showSequential) { setShowSequential(false); return; }
      if (showSnippets) { setShowSnippets(false); return; }
      if (showExtract) { setShowExtract(false); return; }
      if (showEncoding) { setShowEncoding(false); return; }
      if (showBatchReplace) { setShowBatchReplace(false); return; }
      if (showConfigDiff) { setShowConfigDiff(false); return; }
      if (dialogStatesRef.current.showShortcuts) { setShowShortcuts(false); return; }
      if (moveToGroup) { setMoveToGroupItem(null); return; }
      if (selectedIds.size > 0) { store.clearSelection(); return; }
      await toggleWindow();
    } else if (e.key === "?" || (e.shiftKey && e.key === "/")) {
      e.preventDefault();
      setShowShortcuts((v) => !v);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filtered.length === 0) return;
      const currentIdx = focusId ? filtered.findIndex((i) => i.id === focusId) : -1;
      const nextIdx = Math.min(currentIdx + 1, filtered.length - 1);
      store.selectItem(filtered[nextIdx].id);
      // U39：滚动交给 CardList 的 Lenis + 虚拟列表（scrollIntoView 与 Lenis 冲突）
      window.dispatchEvent(new CustomEvent("app-scroll-to-item", { detail: { id: filtered[nextIdx].id } }));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length === 0) return;
      const currentIdx = focusId ? filtered.findIndex((i) => i.id === focusId) : filtered.length;
      const prevIdx = Math.max(currentIdx - 1, 0);
      store.selectItem(filtered[prevIdx].id);
      // U39：滚动交给 CardList 的 Lenis + 虚拟列表（scrollIntoView 与 Lenis 冲突）
      window.dispatchEvent(new CustomEvent("app-scroll-to-item", { detail: { id: filtered[prevIdx].id } }));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const selectedArr = [...selectedIds];
      // 优先用 focusId（键盘导航当前项），其次用 selectedIds 第一项
      const targetId = focusId || selectedArr[0];
      if (targetId) {
        const item = filtered.find((i) => i.id === targetId);
        if (item) {
          // 粘贴信号回写统一走这个闭包。
          //
          // **修复（v6.15）**：以前只有下面的纯文本分支记了事件，
          // image / rich / file 三个分支全漏了。后果不只是统计少几条：
          // history 的「按价值豁免过期清理」靠 paste 信号判定一条内容有没有被用过，
          // 图片粘贴不记事件 → 图片会被当成“没价值”清掉，哪怕天天在用。
          const logPaste = async () => {
            const { logPasteEvent } = await import("@/lib/api/actionEvents");
            // 热键粘贴走的是当前可见列表，下标直接用 filtered 里的位置
            const idx = filtered.findIndex((i) => i.id === item.id);
            logPasteEvent(item.id, item.content_type || item.type, item.source, idx);
          };
          // U1：仅粘贴成功时弹成功提示（pasteText/pasteImage 失败时已自行弹错误 toast）
          if (item.type === "image" && item.content) {
            const ok = await pasteImage(item.content);
            if (ok) {
              window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: "已粘贴图片", type: "success" } }));
              await logPaste();
            }
          } else if (item.type === "rich" && item.content) {
            const ok = await pasteRichGuarded(item.content, item.text);
            if (ok) {
              window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: "已粘贴图文", type: "success" } }));
              await logPaste();
            }
          } else if (item.type === "file" && item.content) {
            // 文件粘贴：将文件路径写入剪贴板
            const ok = await pasteTextGuarded(item.content);
            if (ok) {
              window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: "已粘贴文件路径", type: "success" } }));
              await logPaste();
            }
          } else {
            const ok = await pasteTextGuarded(item.text);
            if (ok) {
              window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: "已粘贴", type: "success" } }));
              await logPaste();
            }
          }
        }
      }
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      const selectedArr = [...selectedIds];
      if (selectedArr.length > 0) {
        await deleteHistory(selectedArr);
      } else if (focusId) {
        await deleteHistory([focusId]);
      }
    } else if (e.ctrlKey && e.key === "a") {
      e.preventDefault();
      store.selectAll();
    } else if (e.ctrlKey && e.key === "d") {
      e.preventDefault();
      const selectedArr = [...selectedIds];
      let pinned: boolean | null = null;
      if (selectedArr.length > 0) {
        pinned = await togglePin(selectedArr[0]);
      } else if (focusId) {
        pinned = await togglePin(focusId);
      }
      if (pinned !== null) toast(pinned ? "已置顶" : "已取消置顶", "success");
    } else if (e.ctrlKey && e.key === "z") {
      e.preventDefault();
      const restored = store.undoDelete();
      if (restored) {
        invalidateCountsCache(); // 撤销恢复后清除计数缓存
        const failedItems: HistoryItem[] = [];
        for (const item of restored) {
          try { await import("@tauri-apps/api/core").then(m => m.invoke("insert_history", { item })); } catch (e) {
            logger.warn("撤销恢复失败", e);
            failedItems.push(item);
          }
        }
        if (failedItems.length > 0) {
          // 修复 M9：后端写入失败时回滚本地恢复的条目并放回撤销栈，
          // 用户可再次 Ctrl+Z 重试 — 此前失败后条目留在本地列表却不在 DB，
          // 撤销栈已消耗无法重试，前后端永久不一致
          const failedIds = new Set(failedItems.map((i) => i.id));
          useAppStore.setState((s) => ({
            history: s.history.filter((h) => !failedIds.has(h.id)),
            undoStack: [failedItems, ...s.undoStack].slice(0, 10),
            _filterCache: null,
          }));
          window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `${failedItems.length}/${restored.length} 条恢复失败，可再次 Ctrl+Z 重试`, type: "error" } }));
        } else {
          window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `已恢复 ${restored.length} 条记录`, type: "success" } }));
        }
      }
    } else if (e.ctrlKey && e.key === "s") {
      e.preventDefault();
      setShowSettings(true);
    } else if (e.ctrlKey && e.key === "h") {
      e.preventDefault();
      setShowSettings(true); // 帮助已整合到设置面板
    } else if (e.key === "Home") {
      e.preventDefault();
      if (filtered.length > 0) {
        store.selectItem(filtered[0].id);
        window.dispatchEvent(new CustomEvent("app-scroll-to-item", { detail: { id: filtered[0].id } }));
      }
    } else if (e.key === "End") {
      e.preventDefault();
      if (filtered.length > 0) {
        const last = filtered[filtered.length - 1];
        store.selectItem(last.id);
        window.dispatchEvent(new CustomEvent("app-scroll-to-item", { detail: { id: last.id } }));
      }
    } else if (e.key === " ") {
      // Space: 快速预览选中的文本（优先 selectedIds，回退 focusId）
      e.preventDefault();
      const targetId = selectedIds.size > 0 ? [...selectedIds][0] : focusId;
      if (targetId) {
        const item = filtered.find((i) => i.id === targetId);
        if (item && item.type === "text") {
          window.dispatchEvent(new CustomEvent("app-quick-preview", { detail: { text: item.text } }));
        } else if (item && (item.type === "image" || item.type === "file")) {
          // U44：图片/文件 → 打开对应详情窗（此前 Space 对它们无响应）
          window.dispatchEvent(new CustomEvent("app-open-item-detail", { detail: { id: item.id } }));
        }
      }
    }
    // 状态都走 ref 读，避免频繁重新注册键盘事件；
    // toast 本身是 useCallback 恒引用，列进依赖不会引起重注册
  }, [toast]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // 加载中页面
  if (loading) {
    return (
      <div className={appStyles.appShell}>
        <div className={appStyles.loadingScreen}>
          {config.theme === "blossom" ? (
            <Heart size={32} className="spin-icon" style={{ color: "var(--accent)", fill: "var(--accent)" }} />
          ) : (
            <Loader2 size={32} className="spin-icon" style={{ color: "var(--accent)" }} />
          )}
          <p className={appStyles.loadingText}>正在加载数据…</p>
        </div>
      </div>
    );
  }

  // 初始化错误页面
  if (initError) {
    return (
        <div className={appStyles.appShell}>
          <div className={appStyles.errorInitState}>
            <div className={appStyles.errorInitIcon}>⚠️</div>
            <h3 className={appStyles.errorInitTitle}>无法加载数据</h3>
            <p className={appStyles.errorInitDesc}>数据库文件可能已损坏，或应用没有读取权限。</p>
            <p className={appStyles.errorInitDetail}>{initError}</p>
            <div className={appStyles.errorInitActions}>
              <button className={appStyles.btnInitSecondary} onClick={() => {
                try { navigator.clipboard.writeText(initError); toast("已复制", "success"); } catch { toast("复制失败", "error"); }
              }}>📋 复制错误详情</button>
              <button className={appStyles.btnInitPrimary} disabled={retrying} style={{ opacity: retrying ? 0.6 : 1, cursor: retrying ? "wait" : "pointer" }} onClick={() => {
                if (retrying) return;
                // 清理上次重试的监听器
                if (retryCleanupRef.current) { retryCleanupRef.current(); retryCleanupRef.current = null; }
                setInitError(null);
                setRetrying(true);
                const init = async () => {
                  try {
                    const { initBackend } = await import("@/lib/api");
                    retryCleanupRef.current = await initBackend();
                  } catch (e) { setInitError(e instanceof Error ? e.message : String(e)); }
                  finally { setRetrying(false); }
                };
                init();
              }}>{retrying ? "⏳ 重试中…" : "🔄 重试加载"}</button>
            </div>
          </div>
        </div>
    );
  }

  return (
      <UpdateProvider>
      <UpdateNotesAutoPop />
      {/* 侧边栏展开态由 Sidebar 组件自己的 open 类控制（见下方 open={sidebarOpen}）；
          此处原有一个按 sidebarOpen 切的展开类，但它在 App.module.css 里从未定义，已移除 */}
      <div className={appStyles.appShell}>
        {/* 皮肤场景层：fixed + z-index:0，衬在玻璃卡片（cardWrap z-index:1）之后 */}
        <SkinScene />
        <TopBar
          onSettings={() => setShowSettings(true)}
          onSequential={() => setShowSequential(true)}
          onSnippets={() => setShowSnippets(true)}
          onExtract={() => setShowExtract(true)}
          onEncoding={() => setShowEncoding(true)}
          onBatchReplace={() => setShowBatchReplace(true)}
          onConfigDiff={() => setShowConfigDiff(true)}
          onNewDiagram={handleNewDiagram}
          onToggleSidebar={toggleSidebar}
          sidebarOpen={sidebarOpen}
        />
        {/* v6.2 主动建议：只在主窗口（用户已打开）inline 出现，绝不弹窗。
            v6.4 方案 B：AI 真能用且处于引导期（更新后 1 周）→ 用 AI 快捷区替代；过期后回归原建议条。
            这里只认 "on"（唯一判定 @/lib/aiAvailability：开关开着 + 密钥配齐，本地厂商免密钥）——
            "nokey"（已启用但缺密钥）必须走回建议条，否则会渲染出一排点下去必然失败的 AI 按钮 */}
        {aiStatus === "on" && aiAwareActive ? <AiQuickBar /> : <SuggestionBar />}
        <div className={appStyles.contentArea}>
          <Sidebar
            open={sidebarOpen}
            activeGroupId={activeGroupId}
            groups={sidebarGroups}
            onSelectGroup={handleSelectGroup}
            onClose={toggleSidebar}
            onCreateGroup={handleCreateGroup}
            onRenameGroup={handleRenameGroup}
            onDeleteGroup={handleDeleteGroup}
            onChangeGroupColor={handleChangeGroupColor}
          />
          <div className={appStyles.cardPanel}>
            <ScrollProvider scrollRef={scrollRef} lenisRef={lenisRef}>
              <CardList scrollRef={scrollRef} lenisRef={lenisRef} showMoveToGroup />
              <BackToTop />
            </ScrollProvider>
          </div>
        </div>
        <QuickPreview />

        {/* 移动到分组选择弹窗 */}
        <AnimatePresence>
          {moveToGroupItem && (
            <motion.div
              {...anim.backdrop}
              className="dialog-backdrop" onClick={() => setMoveToGroupItem(null)}
            >
              <FocusTrap>
              <motion.div
                {...anim.panel}
                className="dialog-box" style={{ maxWidth: 300 }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="dialog-header">
                  <h2 className="dialog-title">📂 移动到分组</h2>
                  <button className="dialog-close" onClick={() => setMoveToGroupItem(null)}><X size={14} /></button>
                </div>
                <div className="dialog-body" style={{ padding: "8px 0" }}>
                  <button
                    onClick={() => handleMoveToGroup(null)}
                    style={{ width: "100%", textAlign: "left", padding: "10px 16px", border: "none", background: "transparent", cursor: "pointer", fontFamily: "inherit", fontSize: 13, display: "flex", alignItems: "center", gap: 10, borderRadius: 0 }}
                  >
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--text-muted)", flexShrink: 0 }} />
                    移除分组
                  </button>
                  {groups.map((g) => (
                    <button
                      key={g.id}
                      onClick={() => handleMoveToGroup(g.id)}
                      style={{ width: "100%", textAlign: "left", padding: "10px 16px", border: "none", background: "transparent", cursor: "pointer", fontFamily: "inherit", fontSize: 13, display: "flex", alignItems: "center", gap: 10, borderRadius: 0, transition: "background 0.1s" }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: g.color, flexShrink: 0 }} />
                      {g.name}
                    </button>
                  ))}
                </div>
              </motion.div>
              </FocusTrap>
            </motion.div>
          )}
        </AnimatePresence>

        <Suspense fallback={null}>
          <ErrorBoundary fallback={null} componentName="设置面板">
            <SettingsDialog open={showSettings} onClose={() => setShowSettings(false)} initialTab={showSettingsTab} />
            <Suspense fallback={null}>
              <PinnedPanel open={showPinnedPanel} onClose={() => setShowPinnedPanel(false)} />
            </Suspense>
          </ErrorBoundary>
          <ErrorBoundary fallback={null} componentName="依次粘贴">
            <SequentialPasteDialog open={showSequential} onClose={() => setShowSequential(false)} />
          </ErrorBoundary>
          <ErrorBoundary fallback={null} componentName="片段库">
            <SnippetsDialog open={showSnippets} onClose={() => setShowSnippets(false)} />
          </ErrorBoundary>
          <ErrorBoundary fallback={null} componentName="提取面板">
            <ExtractDialog open={showExtract} onClose={() => setShowExtract(false)} />
          </ErrorBoundary>
          <ErrorBoundary fallback={null} componentName="编码转换">
            <EncodingDialog open={showEncoding} onClose={() => setShowEncoding(false)} />
          </ErrorBoundary>
          <ErrorBoundary fallback={null} componentName="批量替换">
            <BatchReplaceDialog open={showBatchReplace} onClose={() => setShowBatchReplace(false)} />
          </ErrorBoundary>
          <ErrorBoundary fallback={null} componentName="配置对比">
            <ConfigDiffDialog open={showConfigDiff} onClose={() => setShowConfigDiff(false)} />
          </ErrorBoundary>
        </Suspense>


        {/* 快捷键浮层 — 从 config 动态读取，支持搜索过滤 */}
        <AnimatePresence>
          {showShortcuts && (
            <ShortcutPanel onClose={() => setShowShortcuts(false)} />
          )}
        </AnimatePresence>

        {/* 修复：删除分组的二次确认（原本右键一点就删，无确认也不可撤销） */}
        <ConfirmDialog key="delete-group-confirm"
          open={!!deleteGroupTarget}
          title="确认删除分组"
          message={deleteGroupTarget
            ? (deleteGroupTarget.count > 0
                ? `删除分组「${deleteGroupTarget.name}」？该分组下的 ${deleteGroupTarget.count} 条记录不会被删除，但会变为未分组。此操作无法撤销。`
                : `删除空分组「${deleteGroupTarget.name}」？此操作无法撤销。`)
            : ""}
          confirmText="删除分组"
          variant="danger"
          onConfirm={() => { void executeDeleteGroup(); }}
          onCancel={() => setDeleteGroupTarget(null)}
        />
        {/* 审查：统一确认弹窗宿主（替代散落的 window.confirm） */}
        <ConfirmDialogHost />
      </div>
      </UpdateProvider>
  );
}

/** 自动弹出更新说明弹框：当检测到新版本时自动显示 */
function UpdateNotesAutoPop() {
  const { status, update } = useUpdate();
  const [open, setOpen] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const dismissedRef = useRef<string | null>(null);

  useEffect(() => {
    import("@/lib/api").then(m => m.getAppVersion().then(setAppVersion)).catch(() => {});
  }, []);

  useEffect(() => {
    if (status === "available" && update && dismissedRef.current !== update.version) {
      setOpen(true);
    }
  }, [status, update]);

  const handleClose = useCallback(() => {
    setOpen(false);
    if (update) dismissedRef.current = update.version;
  }, [update]);

  // 常挂载 + AnimatePresence 门控：关闭时子树保留到退场动画结束再卸载。
  // lazy chunk 仍只在首次 open 时加载（条件渲染在 Suspense 外层）
  return (
    <AnimatePresence>
      {open && (
        <Suspense key="update-notes-dialog" fallback={null}>
          <ErrorBoundary fallback={null} componentName="更新说明弹框">
            <UpdateNotesDialog open={open} onClose={handleClose} currentVersion={appVersion} />
          </ErrorBoundary>
        </Suspense>
      )}
    </AnimatePresence>
  );
}

export default App;

/** 快捷键浮层（支持搜索过滤） */
function ShortcutPanel({ onClose }: { onClose: () => void }) {
  const [filter, setFilter] = useState("");
  const config = useAppStore((s) => s.config);
  const allShortcuts = useMemo(() => {
    const dblDesc = config.double_click_action === "copy" ? "双击复制到剪贴板" : "双击预览 / 编辑";
    return [
      { desc: "唤出 / 隐藏窗口", keys: config.hotkey || "Ctrl+Alt+V" },
      { desc: "依次粘贴", keys: config.sequential_hotkey || "Ctrl+Alt+Q" },
      { desc: "全选", keys: config.select_all_hotkey || "Ctrl+A" },
      { desc: "粘贴第 N 条", keys: "Ctrl+Alt+1~9" },
      { desc: "收集模式 开/关", keys: config.stack_toggle_hotkey || "ctrl+alt+k" },
      { desc: "粘贴最近收集的内容", keys: config.stack_paste_hotkey || "ctrl+alt+p" },
      { desc: "快捷粘贴面板", keys: config.quick_paste_hotkey || "alt+v" },
      { desc: "上下导航", keys: "↑ / ↓" },
      { desc: "首尾跳转", keys: "Home / End" },
      { desc: "快速预览", keys: "Space" },
      { desc: "粘贴选中", keys: "Enter" },
      { desc: dblDesc, keys: "双击卡片" },
      { desc: "右键编辑内容", keys: "右键菜单" },
      { desc: "删除选中", keys: "Delete" },
      { desc: "置顶 / 取消", keys: "Ctrl+D" },
      { desc: "撤销删除", keys: "Ctrl+Z" },
      { desc: "打开设置", keys: "Ctrl+S" },
      { desc: "打开帮助", keys: "Ctrl+H" },
      { desc: "显示此面板", keys: "? 或 Shift+/" },
    ];
  }, [config.hotkey, config.sequential_hotkey, config.select_all_hotkey, config.double_click_action, config.stack_toggle_hotkey, config.stack_paste_hotkey, config.quick_paste_hotkey]);

  const filtered = useMemo(() => {
    if (!filter.trim()) return allShortcuts;
    const kw = filter.toLowerCase();
    return allShortcuts.filter(s => s.desc.toLowerCase().includes(kw) || s.keys.toLowerCase().includes(kw));
  }, [filter, allShortcuts]);

  const anim = useDialogAnim();

  return (
    <motion.div
      {...anim.backdrop}
      className="shortcut-overlay" onClick={onClose}
    >
      <motion.div
        {...anim.panel}
        className="shortcut-panel" onClick={(e) => e.stopPropagation()}
      >
        <div className="shortcut-panel-header">
          <span>⌨ 快捷键一览</span>
          <button className="dialog-close" onClick={onClose}><X size={14} /></button>
        </div>
        <div style={{ padding: "8px 16px 0" }}>
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="搜索快捷键…"
            className="snippet-search"
            autoFocus
          />
        </div>
        <div className="shortcut-panel-body">
          {filtered.length === 0 ? (
            <div style={{ textAlign: "center", padding: "20px", color: "var(--text-muted)", fontSize: 12 }}>
              未找到匹配的快捷键
            </div>
          ) : (
            filtered.map((s, i) => (
              <div key={i} className="shortcut-row">
                <span className="shortcut-desc">{s.desc}</span>
                <span className="h-key">{s.keys}</span>
              </div>
            ))
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}


