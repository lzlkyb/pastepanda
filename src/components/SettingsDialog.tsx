import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { useAppStore, HistoryItem, DEFAULT_CONFIG } from "@/stores/appStore";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { VersionBadge } from "@/components/VersionBadge";
import { useToast } from "@/components/Toast";
import { useUpdate } from "@/contexts/UpdateContext";
import { logger } from "@/lib/logger";
import { getStatsDetail, StatsDetail, getAppVersion, getAppName, invalidateCountsCache } from "@/lib/api";
import { CHANGELOG } from "@/lib/changelog.generated";
import { hasUnseenEntries, getLastSeenVersion, setLastSeenVersion } from "@/lib/changelog";
import { GeneralTab } from "@/components/settings/GeneralTab";
import { HelpTabContent } from "@/components/settings/HelpTabContent";
import { AboutTabContent } from "@/components/settings/AboutTabContent";
import { AiTab } from "@/components/settings/AiTab";
import styles from "./Settings.module.css";
import { FocusTrap } from "@/components/FocusTrap";
import { useDialogAnim } from "@/lib/dialogMotion";

const tabPanelVariants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
};
const tabPanelTransition = { duration: 0.22, ease: [0.4, 0, 0.2, 1] as const };

type SettingsTab = "general" | "ai" | "help" | "about";

export function SettingsDialog({ open, onClose, initialTab }: { open: boolean; onClose: () => void; initialTab?: SettingsTab }) {
  const config = useAppStore((s) => s.config);
  const updateConfig = useAppStore((s) => s.updateConfig);
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
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
  const [scrolled, setScrolled] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const { status: updateStatus } = useUpdate();
  const anim = useDialogAnim();

  /** 关于 tab 红点：有新版本可用 或 有未查看过的更新日志 */
  const hasAboutDot = useMemo(() => {
    if (updateStatus === "available" || updateStatus === "ready" || updateStatus === "installed") return true;
    const lastSeen = getLastSeenVersion();
    return lastSeen ? hasUnseenEntries(CHANGELOG, lastSeen) : CHANGELOG.length > 0;
  }, [updateStatus]);

  useEffect(() => {
    if (open) {
      // v6.4 审查：#10 从变换中心跳转过来时直接定位到指定 tab
      setActiveTab(initialTab ?? "general");
      setScrolled(false);
      // 审查：stats 失败不再静默——置错误标记，界面给重试
      setStatsError(false);
      getStatsDetail(config.current_workspace)
        .then((s) => {
          setStats(s);
          setStatsError(false);
        })
        .catch(() => setStatsError(true));
      getAppVersion().then(setAppVersion);
      getAppName().then(setAppName).catch(() => setAppName("PastePanda"));
    }
    // initialTab 只在弹窗打开那一刻消费。列进依赖的话，父组件改一次这个 prop
    // 就会把用户手动切过去的 tab 拉回来。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, config.current_workspace]);

  const handleBodyScroll = useCallback(() => {
    if (bodyRef.current) setScrolled(bodyRef.current.scrollTop > 40);
  }, []);

  const handleTabSwitch = useCallback((tab: SettingsTab) => {
    setActiveTab(tab);
    if (tab === "about" && CHANGELOG.length > 0) {
      setLastSeenVersion(CHANGELOG[0].version);
    }
    if (bodyRef.current) {
      bodyRef.current.scrollTop = 0;
      setScrolled(false);
    }
  }, []);

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
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({ filters: [{ name: "JSON", extensions: ["json"] }] });
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

  const isBlossom = config.theme === "blossom";
  const tabs: { key: SettingsTab; label: string; icon: string }[] = [
    { key: "general", label: "通用", icon: isBlossom ? "🎀" : "⚙" },
    { key: "ai", label: "AI", icon: isBlossom ? "🌸" : "✨" },
    { key: "help", label: "帮助", icon: isBlossom ? "💌" : "📖" },
    { key: "about", label: "关于", icon: isBlossom ? "💗" : "ℹ" },
  ];

  return (
    <AnimatePresence>
      {open && (
        <motion.div key="settings-dialog"
          {...anim.backdrop}
          className="dialog-backdrop" onClick={onClose}>
          <FocusTrap>
          <motion.div
            {...anim.panel}
            className="dialog-box dialog-solid w420" onClick={(e) => e.stopPropagation()}>

            {/* Header */}
            <div className={`dialog-header${scrolled ? ` ${styles.dialogHeaderCompact}` : ""}`}>
              <h2 className={`dialog-title${scrolled ? ` ${styles.dialogTitleCompact}` : ""}`}>⚙ 设置</h2>
              <button onClick={onClose} className={`dialog-close${scrolled ? ` ${styles.dialogCloseCompact}` : ""}`}><X size={16} /></button>
            </div>

            {/* Tab bar */}
            <div className={`${styles.tabBarWrapper}${scrolled ? ` ${styles.tabBarWrapperHidden}` : ""}`}>
              <div className={styles.tabBar}>
                {tabs.map((tab) => {
                  const isActive = activeTab === tab.key;
                  const showDot = tab.key === "about" && hasAboutDot && !isActive;
                  return (
                    <button key={tab.key} onClick={() => handleTabSwitch(tab.key)}
                      className={`${styles.tabBtn} ${isActive ? styles.tabBtnActive : ""}`}>
                      <span className={styles.tabIcon}>{tab.icon}</span>
                      {tab.label}
                      {showDot && <span className={styles.tabDot} />}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Body */}
            <div className="dialog-body" ref={bodyRef} onScroll={handleBodyScroll}
              style={{ "--dialog-body-padding": "0", "--dialog-body-gap": "0" } as React.CSSProperties}>
              <AnimatePresence mode="wait">
                {activeTab === "general" && (
                  <motion.div key="tab-general" variants={tabPanelVariants} initial="initial" animate="animate" exit="exit" transition={tabPanelTransition}>
                    <GeneralTab
                      config={config} updateConfig={updateConfig} updateAndSave={updateAndSave}
                      stats={stats} statsError={statsError} onRetryStats={() => {
                        setStatsError(false);
                        getStatsDetail(config.current_workspace).then(setStats).catch(() => setStatsError(true));
                      }} expiredCount={expiredCount}
                      tabStyle={tabStyle} handleSwitchTabStyle={handleSwitchTabStyle}
                      handleExport={handleExport} handleImport={handleImport} handleCleanup={handleCleanup}
                      exporting={exporting} importing={importing}
                    />
                  </motion.div>
                )}

                {activeTab === "ai" && (
                  <motion.div key="tab-ai" variants={tabPanelVariants} initial="initial" animate="animate" exit="exit" transition={tabPanelTransition}>
                    <AiTab />
                  </motion.div>
                )}

                {activeTab === "help" && (
                  <motion.div key="tab-help" variants={tabPanelVariants} initial="initial" animate="animate" exit="exit" transition={tabPanelTransition}
                    style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
                    <HelpTabContent config={config} appName={appName} appVersion={appVersion} />
                  </motion.div>
                )}

                {activeTab === "about" && (
                  <motion.div key="tab-about" variants={tabPanelVariants} initial="initial" animate="animate" exit="exit" transition={tabPanelTransition}
                    style={{ flex: 1 }}>
                    <AboutTabContent appName={appName} appVersion={appVersion} />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Footer — 方案 B 紧凑两行 */}
            <div className={styles.sFooter}>
              <div className={styles.sFooterRow}>
                <button onClick={() => setShowResetConfirm(true)} className={styles.sResetBtn} title="将所有设置恢复为默认值">恢复默认设置</button>
                <button onClick={onClose} className={styles.sSaveBtn}>关闭设置</button>
              </div>
              <div className={styles.sFooterMeta}>
                <span className={styles.sAutoSaveHint}>所有设置修改后自动保存</span>
                <span className={styles.sFooterVer}><VersionBadge version={appVersion} compact /></span>
              </div>
            </div>
          </motion.div>
          </FocusTrap>
        </motion.div>
      )}
      <ConfirmDialog key="cleanup-confirm"
        open={showCleanupConfirm}
        title="确认清理"
        message={`将删除 ${expiredCount} 条超过 ${cleanupDays} 天的过期记录，确认？`}
        confirmText="确认清理"
        variant="danger"
        onConfirm={executeCleanup}
        onCancel={() => setShowCleanupConfirm(false)}
      />
      <ConfirmDialog key="reset-confirm"
        open={showResetConfirm}
        title="恢复默认设置"
        message="将把主题、热键、自动清理等行为设置恢复为默认值（工作区数据保留），确认？"
        confirmText="恢复默认"
        onConfirm={handleResetDefaults}
        onCancel={() => setShowResetConfirm(false)}
      />
    </AnimatePresence>
  );
}
