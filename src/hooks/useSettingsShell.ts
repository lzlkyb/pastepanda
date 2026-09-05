import { useState, useEffect, useRef, useMemo } from "react";
import { useAppStore, HistoryItem, DEFAULT_CONFIG } from "@/stores/appStore";
import { useToast } from "@/components/Toast";
import { useUpdate } from "@/contexts/UpdateContext";
import { logger } from "@/lib/logger";
import { getStatsDetail, StatsDetail, getAppVersion, getAppName, invalidateCountsCache } from "@/lib/api";
import { CHANGELOG } from "@/lib/changelog.generated";
import { hasUnseenEntries, getLastSeenVersion } from "@/lib/changelog";

/**
 * 设置页的数据与操作层（从 `SettingsView.tsx` 抽出，原本占 180 行）。
 *
 * 拆它的理由不是行数指标：这一堆东西（保存串行、导出导入、清理、恢复默认）
 * 与「菜单高亮到哪一项」完全无关，堆在一个组件里时，改任一边都要先读另一边。
 *
 * ❗ `open` 为 false 时不拉数据也不听事件：设置页关着的时候这些都是白烧（规则 #8）。
 */
export function useSettingsShell(open: boolean) {
  const config = useAppStore((s) => s.config);
  const updateConfig = useAppStore((s) => s.updateConfig);
  const { toast } = useToast();
  const { status: updateStatus } = useUpdate();

  const [tabStyle, setTabStyle] = useState<string>(
    () => localStorage.getItem("tabStyle") || "segmented",
  );
  const [stats, setStats] = useState<StatsDetail | null>(null);
  /** 审查：统计加载失败标记（界面给重试，不再永久 spinner） */
  const [statsError, setStatsError] = useState(false);
  const [appName, setAppName] = useState("PastePanda");
  const [appVersion, setAppVersion] = useState("?.?.?");
  const [showCleanupConfirm, setShowCleanupConfirm] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);

  /** 关于 tab 红点：有新版本可用 或 有未查看过的更新日志 */
  const hasAboutDot = useMemo(() => {
    if (updateStatus === "available" || updateStatus === "ready" || updateStatus === "installed") return true;
    const lastSeen = getLastSeenVersion();
    return lastSeen ? hasUnseenEntries(CHANGELOG, lastSeen) : CHANGELOG.length > 0;
  }, [updateStatus]);

  const loadStats = () => {
    setStatsError(false);
    getStatsDetail(config.current_workspace)
      .then((s) => {
        setStats(s);
        setStatsError(false);
      })
      .catch(() => setStatsError(true));
  };

  useEffect(() => {
    if (!open) return;
    // 审查：stats 失败不再静默——置错误标记，界面给重试
    loadStats();
    getAppVersion().then(setAppVersion);
    getAppName().then(setAppName).catch(() => setAppName("PastePanda"));
    // loadStats 每次渲染都是新函数，列进依赖会变成每渲染都重拉一次统计
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, config.current_workspace]);

  // 串行化配置写入：后一次保存必须在前一次之后执行，且读取最新 store 快照，
  // 避免快速连续切换时闭包过期 config 相互覆盖导致设置丢失（M20）
  const saveChainRef = useRef(Promise.resolve() as Promise<unknown>);

  const updateAndSave = async (partial: Record<string, unknown>) => {
    updateConfig(partial);
    const task = saveChainRef.current.then(async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      // Zustand set 同步生效，此时 getState 已包含 partial
      const newConfig = useAppStore.getState().config;
      await invoke("save_config", { config: newConfig });
    });
    saveChainRef.current = task.catch(() => {});
    try {
      await task;
    } catch (e) {
      logger.warn("即时保存失败", e);
      toast("设置保存失败，请检查数据库权限", "error");
    }
  };

  // 修复 U27：恢复默认设置（保留工作区等用户数据，仅重置行为/外观/热键配置）
  const handleResetDefaults = async () => {
    setShowResetConfirm(false);
    const current = useAppStore.getState().config;
    const reset = {
      ...DEFAULT_CONFIG,
      // 工作区属于用户数据，不随"恢复默认"重置
      current_workspace: current.current_workspace,
      workspaces: current.workspaces,
    };
    await updateAndSave(reset);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("reregister_hotkeys");
    } catch (e) {
      logger.warn("恢复默认后重注册热键失败", e);
    }
    toast("已恢复默认设置", "success");
  };

  const cleanupDays = config.auto_cleanup_days;
  // 过期记录数交给后端精确统计（SQL 与清理条件完全一致）：
  // 前端内存列表是分页缓存且含置顶记录，filter 计算会高估/漏估
  const [expiredCount, setExpiredCount] = useState(0);
  // 设置页打开期间记录可能被删除（深度清理 / 批量删除等都会触发 counts-invalidated），
  // 递增 tick 触发重查，避免"清理过期记录"行显示过期数字
  const [expiredRefreshTick, setExpiredRefreshTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const onInvalidated = () => setExpiredRefreshTick((t) => t + 1);
    window.addEventListener("counts-invalidated", onInvalidated);
    return () => window.removeEventListener("counts-invalidated", onInvalidated);
  }, [open]);
  useEffect(() => {
    if (!open || cleanupDays <= 0) {
      setExpiredCount(0);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const n = await invoke<number>("count_expired_history", {
          workspace: config.current_workspace,
          beforeDays: cleanupDays,
        });
        if (!cancelled) setExpiredCount(n);
      } catch (e) {
        logger.warn("统计过期记录数失败", e);
        if (!cancelled) setExpiredCount(0);
      }
    })();
    return () => { cancelled = true; };
  }, [open, cleanupDays, config.current_workspace, expiredRefreshTick]);

  const handleExport = async () => {
    setExporting(true);
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        filters: [
          { name: "Excel", extensions: ["xlsx"] },
          { name: "CSV", extensions: ["csv"] },
          { name: "JSON", extensions: ["json"] },
        ],
      });
      if (path) {
        const { invoke } = await import("@tauri-apps/api/core");
        const ext = (path as string).split(".").pop()?.toLowerCase();
        if (ext === "xlsx") {
          const count = await invoke<number>("export_history_xlsx", { workspace: config.current_workspace, path });
          toast(`导出成功：${count} 条记录`, "success");
        } else if (ext === "csv") {
          const count = await invoke<number>("export_history_csv", { workspace: config.current_workspace, path });
          toast(`导出成功：${count} 条记录`, "success");
        } else {
          // JSON：保持原有前端写入逻辑
          const allItems = await invoke<HistoryItem[]>("get_all_history", { workspace: config.current_workspace });
          const { writeTextFile } = await import("@tauri-apps/plugin-fs");
          await writeTextFile(path, JSON.stringify(allItems, null, 2));
          toast(`导出成功：${allItems.length} 条记录`, "success");
        }
      }
    } catch (e) {
      logger.warn("导出失败", e);
      toast("导出失败", "error");
    } finally {
      setExporting(false);
    }
  };

  const handleImport = async () => {
    setImporting(true);
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const path = await openDialog({ filters: [{ name: "JSON", extensions: ["json"] }] });
      if (path) {
        const { readTextFile } = await import("@tauri-apps/plugin-fs");
        const text = await readTextFile(path as string);
        const items = JSON.parse(text);
        if (!Array.isArray(items)) { toast("文件格式错误：需要 JSON 数组", "error"); return; }
        const valid = items.filter((item: Record<string, unknown>) =>
          item && typeof item.id === "string" && typeof item.text === "string"
          && typeof item.time === "string" && typeof item.type === "string"
        );
        if (valid.length === 0) { toast("文件中没有有效记录", "error"); return; }
        const { invoke } = await import("@tauri-apps/api/core");
        const count = await invoke<number>("import_history", { items: valid });
        const store = useAppStore.getState();
        const fresh = await invoke<HistoryItem[]>("get_history", { workspace: store.config.current_workspace, filter: "all", search: "", offset: 0, limit: 200 });
        store.setHistory(fresh);
        invalidateCountsCache();
        toast(`导入成功：${count || valid.length} 条记录`, "success");
      }
    } catch (e) {
      logger.warn("导入失败", e);
      toast("导入失败", "error");
    } finally {
      setImporting(false);
    }
  };

  const handleCleanup = async () => {
    if (cleanupDays <= 0 || expiredCount <= 0) return;
    setShowCleanupConfirm(true);
  };

  const executeCleanup = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{ count: number; deleted_items: HistoryItem[] }>("clear_history", { workspace: config.current_workspace, beforeDays: Number(cleanupDays) });
      if (result.count > 0) {
        // 按已删 ID 从内存列表精确移除，不重新拉取整页（避免列表被截断到 limit 条）
        const deletedIds = new Set(result.deleted_items.map((d) => d.id));
        useAppStore.setState((s) => ({
          history: s.history.filter((h) => !deletedIds.has(h.id)),
          selectedIds: new Set([...s.selectedIds].filter((id) => !deletedIds.has(id))),
          _filterCache: null,
          // 手动清理属用户主动操作，保留撤销；自动清理（后端事件）不写撤销栈
          undoStack: [result.deleted_items, ...s.undoStack].slice(0, 10),
        }));
        invalidateCountsCache();
      }
      setExpiredCount(0);
      toast(`已清理 ${result.count} 条过期记录 (Ctrl+Z 撤销)`, "success");
    } catch (e) {
      logger.warn("清理过期记录失败", e);
      // 修复：清理失败时确认框照常关闭、计数不变却无任何提示，补上失败 toast
      toast(`清理过期记录失败：${e instanceof Error ? e.message : String(e)}`, "error");
    }
    setShowCleanupConfirm(false);
  };

  const handleSwitchTabStyle = (style: "segmented" | "circle") => {
    setTabStyle(style);
    localStorage.setItem("tabStyle", style);
    window.dispatchEvent(new StorageEvent("storage", { key: "tabStyle", newValue: style }));
  };

  return {
    config, updateConfig, updateAndSave,
    stats, statsError, retryStats: loadStats,
    appName, appVersion, hasAboutDot,
    tabStyle, handleSwitchTabStyle,
    cleanupDays, expiredCount,
    exporting, importing,
    handleExport, handleImport, handleCleanup, executeCleanup, handleResetDefaults,
    showCleanupConfirm, setShowCleanupConfirm,
    showResetConfirm, setShowResetConfirm,
  };
}

export type SettingsShell = ReturnType<typeof useSettingsShell>;
