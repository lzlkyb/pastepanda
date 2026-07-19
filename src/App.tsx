import { useEffect, useState, useCallback, useRef, lazy, Suspense, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { applyTheme, DEFAULT_THEME, ThemeKey } from "@/lib/theme";
import { useAppStore, GroupFilter, HistoryItem } from "@/stores/appStore";
import { TopBar } from "@/components/TopBar";
import { CardList } from "@/components/CardList";
import { QuickPreview } from "@/components/QuickPreview";
import { ToastProvider, useToast } from "@/components/Toast";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { UpdateProvider } from "@/contexts/UpdateContext";
import { useFirstTimeTip } from "@/hooks/useFirstTimeTip";
import { logger } from "@/lib/logger";
import { pasteText, pasteImage, deleteHistory, togglePin, toggleWindow, sequentialPaste, invalidateCountsCache, createGroup, updateGroup, deleteGroup as deleteGroupApi, moveToGroup } from "@/lib/api";
import { resolveSource, getAutoTagIcon, getAutoTagColor } from "@/lib/source-mappings";
import { ClipboardList, RotateCcw, Loader2, X } from "lucide-react";
import { BackToTop } from "@/components/BackToTop";
import { ScrollProvider } from "@/contexts/ScrollContext";
import { Sidebar, type SidebarGroup } from "@/components/Sidebar";
import type Lenis from "lenis";
import appStyles from "./App.module.css";

// 懒加载对话框组件 — 只在打开时才加载对应 JS chunk
const SettingsDialog = lazy(() => import("@/components/SettingsDialog").then(m => ({ default: m.SettingsDialog })));
const SnippetsDialog = lazy(() => import("@/components/SnippetsDialog").then(m => ({ default: m.SnippetsDialog })));
const ExtractDialog = lazy(() => import("@/components/ExtractDialog").then(m => ({ default: m.ExtractDialog })));

function App() {
  const config = useAppStore((s) => s.config);
  const history = useAppStore((s) => s.history);
  const groups = useAppStore((s) => s.groups);
  const tags = useAppStore((s) => s.tags);
  const seqPointer = useAppStore((s) => s.seqPointer);
  const resetSeqPointer = useAppStore((s) => s.resetSeqPointer);
  const sourceFilter = useAppStore((s) => s.sourceFilter);
  const setSourceFilter = useAppStore((s) => s.setSourceFilter);
  const groupFilter = useAppStore((s) => s.groupFilter);
  const setGroupFilter = useAppStore((s) => s.setGroupFilter);
  const filterType = useAppStore((s) => s.filterType);
  const { toast } = useToast();
  const seqTotal = history.filter((h) => h.type === "text").length;
  const [showSettings, setShowSettings] = useState(false);
  const [showSnippets, setShowSnippets] = useState(false);
  const [showExtract, setShowExtract] = useState(false);
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

  // 监听来自 api.ts 的 toast 通知（如自动清理）和首次提示
  useEffect(() => {
    const toastHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.message) toast(detail.message, detail.type || "info");
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast]);

  // 组件卸载时清理 retry 创建的监听器
  useEffect(() => {
    return () => { if (retryCleanupRef.current) retryCleanupRef.current(); };
  }, []);





  // 失焦自动隐藏（弹窗打开时跳过）—— 使用 useRef 避免闭包陷阱
  const dialogOpen = showSettings || showSnippets || showExtract;
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

  // 侧边栏分组数据（从 history[].source 自动聚合来源分组 + 用户自定义分组）
  const sidebarGroups = useMemo<SidebarGroup[]>(() => {
    const ws = config.current_workspace;
    const wsItems = history.filter(h => h.workspace === ws);
    const pinnedCount = wsItems.filter(h => h.pinned).length;
    const ungroupedCount = wsItems.filter(h => h.group_id == null).length;

    // 内置分组：全部 + 收藏 + 未分组
    const builtin: SidebarGroup[] = [
      { id: "all", name: "全部", count: wsItems.length, icon: "📋", isBuiltin: true, section: "builtin" as const },
      { id: "starred", name: "收藏", count: pinnedCount, icon: "⭐", isBuiltin: true, section: "builtin" as const },
      { id: "ungrouped", name: "未分组", count: ungroupedCount, icon: "📂", isBuiltin: true, section: "builtin" as const },
    ];

    // 用户自定义分组
    const userGroupItems: SidebarGroup[] = groups.map(g => ({
      id: g.id,
      name: g.name,
      count: wsItems.filter(h => h.group_id === g.id).length,
      color: g.color,
      isBuiltin: false,
      isUserGroup: true,
      section: "user" as const,
    }));

    // 来源分组：从 source 字段聚合，清洗名称 + 映射图标，按计数降序排列
    const sourceCountMap = new Map<string, { count: number; displayName: string; icon: string; sourceIcon: string | null }>();
    wsItems.forEach(h => {
      if (h.source) {
        const entry = sourceCountMap.get(h.source);
        if (entry) {
          entry.count++;
        } else {
          const resolved = resolveSource(h.source);
          sourceCountMap.set(h.source, { count: 1, displayName: resolved.displayName, icon: resolved.icon, sourceIcon: h.source_icon ?? null });
        }
      }
    });
    const dotColors = ["#3B82F6", "#22C55E", "#F97316", "#A855F7", "#EF4444", "#EC4899", "#14B8A6", "#F59E0B", "#6366F1"];
    const sourceGroups: SidebarGroup[] = Array.from(sourceCountMap.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .map(([raw, { count, displayName, icon, sourceIcon }], i) => ({
        id: `source:${raw}`,
        name: displayName,
        count,
        icon,
        color: dotColors[i % dotColors.length],
        isBuiltin: false,
        section: "source" as const,
        sourceRaw: raw,
        sourceIcon,
      }));

    // 智能分类分组：从 AI 自动标签（source="auto"）聚合虚拟分组
    const autoTags = tags.filter(t => t.source === "auto");
    const autoTagGroups: SidebarGroup[] = autoTags
      .map((t, i) => {
        // 统计拥有此标签的记录数
        const count = wsItems.filter(h =>
          (h.tags || []).some(ht => ht.id === t.id)
        ).length;
        return {
          id: `auto:${t.id}`,
          name: t.name,
          count,
          icon: getAutoTagIcon(t.name),
          color: getAutoTagColor(t.name, i),
          isBuiltin: false,
          section: "auto" as const,
        };
      })
      .filter(g => g.count > 0)
      .sort((a, b) => b.count - a.count);

    return [...builtin, ...userGroupItems, ...sourceGroups, ...autoTagGroups];
  }, [history, config.current_workspace, groups, tags]);

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
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRenameGroup = useCallback(async (id: string, name: string) => {
    const group = groups.find(g => g.id === id);
    if (!group) return;
    await updateGroup(id, name, group.color, group.icon);
  }, [groups]);

  const handleDeleteGroup = useCallback(async (id: string) => {
    const group = groups.find(g => g.id === id);
    if (!group) return;
    await deleteGroupApi(id);
    window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `已删除分组「${group.name}」`, type: "info" } }));
  }, [groups]);

  const handleChangeGroupColor = useCallback(async (id: string, color: string) => {
    const group = groups.find(g => g.id === id);
    if (!group) return;
    await updateGroup(id, group.name, color, group.icon);
  }, [groups]);

  // 移动到分组（api.ts 的 moveToGroup 接收 historyIds: string[]）
  const handleMoveToGroup = useCallback(async (groupId: string | null) => {
    if (!moveToGroupItem) return;
    await moveToGroup([moveToGroupItem.id], groupId);
    if (groupId) {
      const group = groups.find(g => g.id === groupId);
      window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `已移动到「${group?.name || groupId}」`, type: "success" } }));
    } else {
      window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: "已移除分组", type: "success" } }));
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
    async function setup() {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        // 托盘"设置"菜单项 → 打开设置弹窗
        const fn = await listen("tray-open-settings", () => {
          setShowSettings(true);
        });
        if (cancelled) {
          // effect 已在本次 setup 完成前被清理（StrictMode 重挂载 / HMR），立即取消订阅，避免监听器泄漏
          fn();
        } else {
          unlisten = fn;
        }
      } catch (e) { logger.warn("注册托盘事件监听失败", e); }
    }
    setup();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
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
          toast(`快捷键注册失败：${event.payload}，可能已被其他程序占用，请前往设置更换`, "error");
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          toast("📋 已自动保存到 PastePanda，Ctrl+Shift+V 随时唤出", "success", 4000);
          markShown("first_copy");
        }
      }, 500);
      return () => clearTimeout(timer);
    }
    historyLenRef.current = history.length;
  }, [history.length, loading, shouldShow, markShown, toast]);

  // 累计使用 3 天后提示依次粘贴功能
  useEffect(() => {
    if (loading) return;
    const timer = setTimeout(() => {
      if (shouldShow("seq_paste_tip")) {
        const daysSinceInstall = Number(localStorage.getItem("pasteship_install_day") || 0);
        const now = Math.floor(Date.now() / 86400000);
        if (!daysSinceInstall) {
          localStorage.setItem("pasteship_install_day", String(now));
        } else if (now - daysSinceInstall >= 3) {
          toast("💡 试试 Ctrl+Q 依次粘贴，逐条粘贴超方便", "info", 4000);
          markShown("seq_paste_tip");
        }
      }
    }, 10000); // 启动 10 秒后检查
    return () => clearTimeout(timer);
  }, [loading, shouldShow, markShown, toast]);

  // 使用 ref 存储弹窗状态，避免 handleKeyDown 依赖变化导致频繁重新注册事件
  const dialogStatesRef = useRef({ showSettings, showSnippets, showExtract, showShortcuts });
  dialogStatesRef.current = { showSettings, showSnippets, showExtract, showShortcuts };

  // 键盘导航
  const handleKeyDown = useCallback(async (e: KeyboardEvent) => {
    // 忽略输入框内的按键
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    // 弹窗打开时：ESC/? 正常工作，其余列表导航按键被屏蔽（让弹窗内部控件如 Tab 可以正常使用）
    const { showSettings, showSnippets, showExtract } = dialogStatesRef.current;
    const dialogOpen = showSettings || showSnippets || showExtract;
    const isListNavKey = ["ArrowDown", "ArrowUp", "Enter", "Delete", "Backspace", "Home", "End"].includes(e.key)
      || (e.ctrlKey && (e.key === "d" || e.key === "z" || e.key === "s" || e.key === "h" || e.key === "a"));
    if (dialogOpen && e.key !== "Escape" && e.key !== "?" && isListNavKey) return;

    const store = useAppStore.getState();
    const filtered = store.getFilteredItems();
    const selectedIds = store.selectedIds;
    const focusId = store.focusId;

    if (e.key === "Escape") {
      e.preventDefault();
      // 弹窗打开时，按 ESC 关闭弹窗（而不是什么都不做）
      if (showSettings) { setShowSettings(false); return; }
      if (showSnippets) { setShowSnippets(false); return; }
      if (showExtract) { setShowExtract(false); return; }
      if (dialogStatesRef.current.showShortcuts) { setShowShortcuts(false); return; }
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
      // 滚动到视图内
      const targetEl = document.querySelector(`[data-item-id="${filtered[nextIdx].id}"]`);
      if (targetEl) targetEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length === 0) return;
      const currentIdx = focusId ? filtered.findIndex((i) => i.id === focusId) : filtered.length;
      const prevIdx = Math.max(currentIdx - 1, 0);
      store.selectItem(filtered[prevIdx].id);
      // 滚动到视图内
      const targetEl = document.querySelector(`[data-item-id="${filtered[prevIdx].id}"]`);
      if (targetEl) targetEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const selectedArr = [...selectedIds];
      // 优先用 focusId（键盘导航当前项），其次用 selectedIds 第一项
      const targetId = focusId || selectedArr[0];
      if (targetId) {
        const item = filtered.find((i) => i.id === targetId);
        if (item) {
          if (item.type === "image" && item.content) {
            await pasteImage(item.content);
            window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: "已粘贴图片", type: "success" } }));
          } else if (item.type === "file" && item.content) {
            // 文件粘贴：将文件路径写入剪贴板
            await pasteText(item.content);
            window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: "已粘贴文件路径", type: "success" } }));
          } else {
            await pasteText(item.text);
            window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: "已粘贴", type: "success" } }));
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
      if (selectedArr.length > 0) {
        await togglePin(selectedArr[0]);
      } else if (focusId) {
        await togglePin(focusId);
      }
    } else if (e.ctrlKey && e.key === "z") {
      e.preventDefault();
      const restored = store.undoDelete();
      if (restored) {
        invalidateCountsCache(); // 撤销恢复后清除计数缓存
        const failed: string[] = [];
        for (const item of restored) {
          try { await import("@tauri-apps/api/core").then(m => m.invoke("insert_history", { item })); } catch (e) {
            logger.warn("撤销恢复失败", e);
            failed.push(item.text.slice(0, 30));
          }
        }
        if (failed.length > 0) {
          window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `部分恢复失败 (${failed.length}/${restored.length})，请检查数据完整性`, type: "error" } }));
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
      if (filtered.length > 0) store.selectItem(filtered[0].id);
    } else if (e.key === "End") {
      e.preventDefault();
      if (filtered.length > 0) store.selectItem(filtered[filtered.length - 1].id);
    } else if (e.key === " ") {
      // Space: 快速预览选中的文本（优先 selectedIds，回退 focusId）
      e.preventDefault();
      const targetId = selectedIds.size > 0 ? [...selectedIds][0] : focusId;
      if (targetId) {
        const item = filtered.find((i) => i.id === targetId);
        if (item && item.type === "text") {
          window.dispatchEvent(new CustomEvent("app-quick-preview", { detail: { text: item.text } }));
        }
      }
    }
  }, []); // 使用 ref 存储状态，避免频繁重新注册键盘事件

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // 加载中页面
  if (loading) {
    return (
      <ToastProvider>
        <div className={appStyles.appShell}>
          <div className={appStyles.loadingScreen}>
            <Loader2 size={32} className="spin-icon" style={{ color: "var(--accent)" }} />
            <p className={appStyles.loadingText}>正在加载数据…</p>
          </div>
        </div>
      </ToastProvider>
    );
  }

  // 初始化错误页面
  if (initError) {
    return (
      <ToastProvider>
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
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <UpdateProvider>
      <div className={`${appStyles.appShell} ${sidebarOpen ? appStyles.sidebarExpanded : ''}`}>
        <TopBar
          onSettings={() => setShowSettings(true)}
          onSnippets={() => setShowSnippets(true)}
          onExtract={() => setShowExtract(true)}
          onToggleSidebar={toggleSidebar}
          sidebarOpen={sidebarOpen}
        />
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

            {/* FAB — 依次粘贴悬浮按钮，定位在卡片面板底部 */}
            {seqTotal > 0 && (
              <motion.div initial={{ opacity: 0, y: 20, scale: 0.9 }} animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 10, scale: 0.9 }} transition={{ type: "spring", stiffness: 400, damping: 25 }}
                className={appStyles.fabContainer}>
                <div className={appStyles.fabCounter}><span className={appStyles.fabCounterNum}>{Math.min(seqPointer, seqTotal)}</span><span className={appStyles.fabCounterSep}>/</span>{seqTotal}</div>
                <button className={appStyles.fabBtn} onClick={() => sequentialPaste()}>
                  <ClipboardList size={14} /> 粘贴
                  <span className={appStyles.fabBtnReset} onClick={(e) => { e.stopPropagation(); resetSeqPointer(); }}><RotateCcw size={10} /></span>
                </button>
              </motion.div>
            )}
          </div>
        </div>
        <QuickPreview />

        {/* 移动到分组选择弹窗 */}
        <AnimatePresence>
          {moveToGroupItem && (
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="dialog-backdrop" style={{ zIndex: 100 }} onClick={() => setMoveToGroupItem(null)}
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 16 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 16 }}
                transition={{ type: "spring", stiffness: 400, damping: 30 }}
                className="dialog-box" style={{ maxWidth: 300 }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="dialog-header">
                  <h2 className="dialog-title">📂 移动到分组</h2>
                  <button className="dialog-close" onClick={() => setMoveToGroupItem(null)}><X size={14} /></button>
                </div>
                <div className="dialog-body" style={{ padding: "8px 0" }}>
                  <button
                    className={`${appStyles.moveGroupItem}`}
                    onClick={() => handleMoveToGroup(null)}
                    style={{ width: "100%", textAlign: "left", padding: "10px 16px", border: "none", background: "transparent", cursor: "pointer", fontFamily: "inherit", fontSize: 13, display: "flex", alignItems: "center", gap: 10, borderRadius: 0 }}
                  >
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#9CA3AF", flexShrink: 0 }} />
                    移除分组
                  </button>
                  {groups.map((g) => (
                    <button
                      key={g.id}
                      className={`${appStyles.moveGroupItem}`}
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
            </motion.div>
          )}
        </AnimatePresence>

        <Suspense fallback={null}>
          <ErrorBoundary fallback={null} componentName="设置面板">
            <SettingsDialog open={showSettings} onClose={() => setShowSettings(false)} />
          </ErrorBoundary>
          <ErrorBoundary fallback={null} componentName="片段库">
            <SnippetsDialog open={showSnippets} onClose={() => setShowSnippets(false)} />
          </ErrorBoundary>
          <ErrorBoundary fallback={null} componentName="提取面板">
            <ExtractDialog open={showExtract} onClose={() => setShowExtract(false)} />
          </ErrorBoundary>
        </Suspense>


        {/* 快捷键浮层 — 从 config 动态读取，支持搜索过滤 */}
        <AnimatePresence>
          {showShortcuts && (
            <ShortcutPanel onClose={() => setShowShortcuts(false)} />
          )}
        </AnimatePresence>
      </div>
      </UpdateProvider>
    </ToastProvider>
  );
}

export default App;

/** 快捷键浮层（支持搜索过滤） */
function ShortcutPanel({ onClose }: { onClose: () => void }) {
  const [filter, setFilter] = useState("");
  const config = useAppStore((s) => s.config);
  const allShortcuts = useMemo(() => {
    return [
      { desc: "唤出 / 隐藏窗口", keys: config.hotkey || "Ctrl+Shift+V" },
      { desc: "依次粘贴", keys: config.sequential_hotkey || "Ctrl+Q" },
      { desc: "全选", keys: config.select_all_hotkey || "Ctrl+A" },
      { desc: "粘贴第 N 条", keys: "Ctrl+Alt+1~9" },
      { desc: "上下导航", keys: "↑ / ↓" },
      { desc: "首尾跳转", keys: "Home / End" },
      { desc: "快速预览", keys: "Space" },
      { desc: "粘贴选中", keys: "Enter" },
      { desc: "双击复制到剪贴板", keys: "双击卡片" },
      { desc: "右键编辑内容", keys: "右键菜单" },
      { desc: "删除选中", keys: "Delete" },
      { desc: "置顶 / 取消", keys: "Ctrl+D" },
      { desc: "撤销删除", keys: "Ctrl+Z" },
      { desc: "打开设置", keys: "Ctrl+S" },
      { desc: "打开帮助", keys: "Ctrl+H" },
      { desc: "显示此面板", keys: "? 或 Shift+/" },
    ];
  }, [config.hotkey, config.sequential_hotkey, config.select_all_hotkey]);

  const filtered = useMemo(() => {
    if (!filter.trim()) return allShortcuts;
    const kw = filter.toLowerCase();
    return allShortcuts.filter(s => s.desc.toLowerCase().includes(kw) || s.keys.toLowerCase().includes(kw));
  }, [filter, allShortcuts]);

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="shortcut-overlay" onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 16 }}
        transition={{ type: "spring", stiffness: 400, damping: 30 }}
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


