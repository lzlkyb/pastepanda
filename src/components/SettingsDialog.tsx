import { useState, useCallback, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { useAppStore, HistoryItem } from "@/stores/appStore";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { VersionBadge } from "@/components/VersionBadge";
import { useToast } from "@/components/Toast";
import { logger } from "@/lib/logger";
import { getStats, Stats, getAppVersion, getAppName, invalidateCountsCache } from "@/lib/api";
import { GeneralTab } from "@/components/settings/GeneralTab";
import { HelpTabContent } from "@/components/settings/HelpTabContent";
import { AboutTabContent } from "@/components/settings/AboutTabContent";
import styles from "./Settings.module.css";

const tabPanelVariants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
};
const tabPanelTransition = { duration: 0.22, ease: [0.4, 0, 0.2, 1] as const };

type SettingsTab = "general" | "help" | "about";

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const config = useAppStore((s) => s.config);
  const updateConfig = useAppStore((s) => s.updateConfig);
  const history = useAppStore((s) => s.history);
  const [saved, setSaved] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [tabStyle, setTabStyle] = useState<string>(
    () => localStorage.getItem("tabStyle") || "segmented",
  );
  const [stats, setStats] = useState<Stats>({ total: 0, pinned: 0, today: 0, text_count: 0, image_count: 0, file_count: 0, earliest_time: null, db_size_kb: 0 });
  const [appName, setAppName] = useState("PastePanda");
  const [appVersion, setAppVersion] = useState("?.?.?");
  const [showCleanupConfirm, setShowCleanupConfirm] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (open) {
      setActiveTab("general");
      setScrolled(false);
      getStats(config.current_workspace).then(setStats).catch(() => {});
      getAppVersion().then(setAppVersion);
      getAppName().then(setAppName).catch(() => setAppName("PastePanda"));
    }
  }, [open, config.current_workspace]);

  const handleBodyScroll = useCallback(() => {
    if (bodyRef.current) setScrolled(bodyRef.current.scrollTop > 40);
  }, []);

  const handleTabSwitch = useCallback((tab: SettingsTab) => {
    setActiveTab(tab);
    if (bodyRef.current) {
      bodyRef.current.scrollTop = 0;
      setScrolled(false);
    }
  }, []);

  const handleSave = async () => {
    let success = true;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("save_config", { config });
      await invoke("reregister_hotkeys").catch((e: unknown) => logger.warn("重注册热键失败", e));
    } catch (e) {
      logger.warn("保存配置失败", e);
      success = false;
      toast("保存配置失败，请检查数据库权限", "error");
    }
    if (success) {
      setSaved(true);
      toast("配置已保存", "success");
      setTimeout(() => setSaved(false), 2000);
    }
  };

  const updateAndSave = async (partial: Record<string, unknown>) => {
    updateConfig(partial);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const newConfig = { ...config, ...partial };
      await invoke("save_config", { config: newConfig });
    } catch (e) {
      logger.warn("即时保存失败", e);
      toast("设置保存失败，请检查数据库权限", "error");
    }
  };

  const cleanupDays = config.auto_cleanup_days;
  const expiredCount = cleanupDays > 0
    ? history.filter((h) => {
        const t = h.time.replace(" ", "T");
        const recordTime = new Date(t).getTime();
        return Date.now() - recordTime > cleanupDays * 86400000;
      }).length
    : 0;

  const handleExport = async () => {
    setExporting(true);
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({ filters: [{ name: "JSON", extensions: ["json"] }] });
      if (path) {
        const { invoke } = await import("@tauri-apps/api/core");
        const allItems = await invoke<HistoryItem[]>("get_all_history", { workspace: config.current_workspace });
        const { writeTextFile } = await import("@tauri-apps/plugin-fs");
        await writeTextFile(path, JSON.stringify(allItems, null, 2));
        toast(`导出成功：${allItems.length} 条记录`, "success");
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
      const result = await invoke<{ count: number; deleted_items: HistoryItem[] }>("clear_history", { workspace: config.current_workspace, before_days: Number(cleanupDays) });
      const store = useAppStore.getState();
      const fresh = await invoke<HistoryItem[]>("get_history", { workspace: store.config.current_workspace, filter: "all", search: "", offset: 0, limit: 200 });
      store.setHistory(fresh);
      useAppStore.setState((s) => ({ undoStack: [result.deleted_items, ...s.undoStack].slice(0, 10) }));
      invalidateCountsCache();
      toast(`已清理 ${result.count} 条过期记录 (Ctrl+Z 撤销)`, "success");
    } catch (e) { logger.warn("清理过期记录失败", e); }
    setShowCleanupConfirm(false);
  };

  const handleSwitchTabStyle = (style: "segmented" | "circle") => {
    setTabStyle(style);
    localStorage.setItem("tabStyle", style);
    window.dispatchEvent(new StorageEvent("storage", { key: "tabStyle", newValue: style }));
  };

  const tabs: { key: SettingsTab; label: string; icon: string }[] = [
    { key: "general", label: "通用", icon: "⚙" },
    { key: "help", label: "帮助", icon: "📖" },
    { key: "about", label: "关于", icon: "ℹ" },
  ];

  return (
    <AnimatePresence>
      {open && (
        <motion.div key="settings-dialog"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="dialog-backdrop" onClick={onClose}>
          <motion.div
            initial={{ scale: 0.96, opacity: 0, y: 10 }} animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.96, opacity: 0, y: 10 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            className="dialog-box w500" onClick={(e) => e.stopPropagation()}>

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
                  return (
                    <button key={tab.key} onClick={() => handleTabSwitch(tab.key)}
                      className={`${styles.tabBtn} ${isActive ? styles.tabBtnActive : ""}`}>
                      <span className={styles.tabIcon}>{tab.icon}</span>
                      {tab.label}
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
                      stats={stats} history={history}
                      tabStyle={tabStyle} handleSwitchTabStyle={handleSwitchTabStyle}
                      handleExport={handleExport} handleImport={handleImport} handleCleanup={handleCleanup}
                      exporting={exporting} importing={importing}
                    />
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

            {/* Footer */}
            <div className={styles.sFooter}>
              <button onClick={onClose} className={styles.sSaveBtn}>关闭设置</button>
              <span className={styles.sFooterVer}>{appName} <VersionBadge version={appVersion} compact /></span>
            </div>
          </motion.div>
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
    </AnimatePresence>
  );
}
