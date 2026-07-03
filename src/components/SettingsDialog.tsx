import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, ChevronRight, Search, ExternalLink } from "lucide-react";
import { useAppStore, HistoryItem, AppConfig } from "@/stores/appStore";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { VersionBadge } from "@/components/VersionBadge";
import { HelpTooltip } from "@/components/HelpTooltip";
import { UpdateBanner } from "@/components/UpdateBadge";
import { AppIcon } from "@/components/AppIcon";
import { useUpdate } from "@/contexts/UpdateContext";
import { THEMES, applyTheme, ThemeKey } from "@/lib/theme";
import { useToast } from "@/components/Toast";
import { logger } from "@/lib/logger";
import { getStats, Stats, getAppVersion, getAppName } from "@/lib/api";
import styles from "./Settings.module.css";
import helpStyles from "./Help.module.css";
import aboutStyles from "./About.module.css";

/* ===== Tab 面板过渡动画配置 ===== */
const tabPanelVariants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
};
const tabPanelTransition = { duration: 0.22, ease: [0.4, 0, 0.2, 1] as const };

const THEME_PREVIEWS: Record<string, { bg: string; accent: string; text: string; barBg: string; bodyBg: string; lineBg: string }> = {
  "ocean":    { bg: "#F4F6F9", accent: "#0284C7", text: "#64748B", barBg: "#fff", bodyBg: "#F4F6F9", lineBg: "#E0E4EB" },
  "midnight": { bg: "#09090B", accent: "#818CF8", text: "#A1A1AA", barBg: "#18181B", bodyBg: "#09090B", lineBg: "#27272A" },
  "forest":   { bg: "#F2F7F5", accent: "#059669", text: "#78716C", barBg: "#fff", bodyBg: "#F2F7F5", lineBg: "#D1D9D3" },
  "blossom":  { bg: "#FFFBFD", accent: "#EC4899", text: "#A68A96", barBg: "#fff", bodyBg: "#FFFBFD", lineBg: "#F3E8ED" },
  "terminal": { bg: "#0A0A0A", accent: "#22C55E", text: "#A3A3A3", barBg: "#141414", bodyBg: "#0A0A0A", lineBg: "#262626" },
  "sunset":   { bg: "#1C1410", accent: "#F97316", text: "#B8A99A", barBg: "#281E18", bodyBg: "#1C1410", lineBg: "#3D3028" },
};

const CLEANUP_OPTIONS = [
  { label: "关", value: 0 },
  { label: "7天", value: 7 },
  { label: "15天", value: 15 },
  { label: "30天", value: 30 },
  { label: "60天", value: 60 },
];

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
  const bodyRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  // 加载统计数据 & 重置 Tab
  useEffect(() => {
    if (open) {
      setActiveTab("general");
      setScrolled(false);
      getStats(config.current_workspace).then(setStats).catch(() => {});
      getAppVersion().then(setAppVersion);
      getAppName().then(setAppName).catch(() => setAppName("PastePanda"));
    }
  }, [open, config.current_workspace]);

  // 滚动监听：超过 40px 时隐藏 tab bar + header 紧凑
  const handleBodyScroll = useCallback(() => {
    if (bodyRef.current) {
      setScrolled(bodyRef.current.scrollTop > 40);
    }
  }, []);

  // 切换 tab 时滚动到顶部
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

  // 即时保存：toggle/选择器切换后立即写入后端，不等保存按钮
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

  const dataSize = JSON.stringify(history).length;
  const dataSizeKB = (dataSize / 1024).toFixed(1);
  const cleanupDays = config.auto_cleanup_days;
  const expiredCount = cleanupDays > 0
    ? history.filter((h) => {
        // 将 "YYYY-MM-DD HH:MM:SS" 解析为本地时间（与 Rust Local::now 一致）
        const t = h.time.replace(" ", "T");
        const recordTime = new Date(t).getTime();
        return Date.now() - recordTime > cleanupDays * 86400000;
      }).length
    : 0;

  const handleExport = async () => {
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
    }
  };

  const handleImport = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({ filters: [{ name: "JSON", extensions: ["json"] }] });
      if (path) {
        const { readTextFile } = await import("@tauri-apps/plugin-fs");
        const text = await readTextFile(path as string);
        const items = JSON.parse(text);
        if (!Array.isArray(items)) {
          toast("文件格式错误：需要 JSON 数组", "error");
          return;
        }
        // 验证必要字段
        const valid = items.filter((item: Record<string, unknown>) =>
          item && typeof item.id === "string" && typeof item.text === "string"
          && typeof item.time === "string" && typeof item.type === "string"
        );
        if (valid.length === 0) {
          toast("文件中没有有效记录", "error");
          return;
        }
        const { invoke } = await import("@tauri-apps/api/core");
        const count = await invoke<number>("import_history", { items: valid });
        const store = useAppStore.getState();
        const fresh = await invoke<HistoryItem[]>("get_history", { workspace: store.config.current_workspace, filter: "all", search: "", offset: 0, limit: 200 });
        store.setHistory(fresh);
        toast(`导入成功：${count || valid.length} 条记录`, "success");
      }
    } catch (e) {
      logger.warn("导入失败", e);
      toast("导入失败", "error");
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
      // 将清理的记录保存到撤销栈
      useAppStore.setState((s) => ({ undoStack: [result.deleted_items, ...s.undoStack].slice(0, 10) }));
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

            {/* Tab bar — below header, hides on scroll */}
            <div className={`${styles.tabBarWrapper}${scrolled ? ` ${styles.tabBarWrapperHidden}` : ""}`}>
              <div className={styles.tabBar}>
                {tabs.map((tab) => {
                  const isActive = activeTab === tab.key;
                  return (
                    <button
                      key={tab.key}
                      onClick={() => handleTabSwitch(tab.key)}
                      className={`${styles.tabBtn} ${isActive ? styles.tabBtnActive : ""}`}
                    >
                      <span className={styles.tabIcon}>{tab.icon}</span>
                      {tab.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Body — AnimatePresence tab 切换 */}
            <div className="dialog-body" ref={bodyRef} onScroll={handleBodyScroll} style={{ "--dialog-body-padding": "0", "--dialog-body-gap": "0" } as React.CSSProperties}>
              <AnimatePresence mode="wait">
                {activeTab === "general" && (
                  <motion.div key="tab-general" variants={tabPanelVariants} initial="initial" animate="animate" exit="exit" transition={tabPanelTransition}>

                {/* ── 数据统计 ── */}
                <div className={styles.sSection}>数据统计</div>
                <div className={styles.statsPanel}>
                  <div className={styles.statsPanelHeader}>
                    📊 剪贴板数据概览
                  </div>
                  <div className={styles.statsPanelGrid}>
                    <div className={styles.statCell}>
                      <div className={`${styles.statNum}`}>{stats.total}</div>
                      <div className={styles.statLabel}>总记录</div>
                    </div>
                    <div className={styles.statCell}>
                      <div className={`${styles.statNum} ${styles.statGreen}`}>{stats.pinned}</div>
                      <div className={styles.statLabel}>⭐ 收藏</div>
                    </div>
                    <div className={styles.statCell}>
                      <div className={`${styles.statNum} ${styles.statOrange}`}>{stats.today}</div>
                      <div className={styles.statLabel}>今日新增</div>
                    </div>
                    <div className={styles.statCell}>
                      <div className={`${styles.statNum} ${styles.statAccent}`}>{stats.text_count}</div>
                      <div className={styles.statLabel}>📝 文本</div>
                    </div>
                    <div className={styles.statCell}>
                      <div className={`${styles.statNum} ${styles.statAccent}`}>{stats.image_count}</div>
                      <div className={styles.statLabel}>🖼 图片</div>
                    </div>
                    <div className={styles.statCell}>
                      <div className={`${styles.statNum} ${styles.statAccent}`}>{stats.file_count}</div>
                      <div className={styles.statLabel}>📁 文件</div>
                    </div>
                  </div>
                  <div className={styles.statsPanelFooter}>
                    <span>💾 {stats.db_size_kb.toFixed(1)} KB</span>
                    {stats.earliest_time && <span>📅 最早: {stats.earliest_time.split(" ")[0]}</span>}
                    <span>📦 {config.current_workspace || "默认"} 空间</span>
                  </div>
                </div>

                {/* ── 外观 ── */}
                <div className={styles.sSection}>外观</div>
                <div className={styles.sRow} style={{ flexDirection: "column", alignItems: "stretch", gap: 12 }}>
                  <span className={styles.sRowIcon} style={{ background: "linear-gradient(135deg, #0078D4, #5856D6)", width: "fit-content", padding: "6px 12px" }}>🎨</span>
                  <div className={styles.sRowBody}>
                    <div className={styles.sRowLabel}>
                      主题配色
                      <HelpTooltip
                        tooltip="6种精心调配的主题配色"
                        detailTitle="主题配色"
                        detail={<>
                          <p>6 种精心调配的主题，点击即可预览，实时生效。</p>
                          <p>💡 <b>海洋</b>：柔和护眼，适合长时间使用</p>
                          <p>💡 <b>终端</b>：程序员风格，代码感十足</p>
                          <p>💡 <b>午夜</b>：暗色模式，夜间使用不刺眼</p>
                        </>}
                      />
                    </div>
                    <div className={styles.sRowDesc}>选择你喜欢的配色方案</div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {THEMES.map((t, idx) => {
                      const prev = THEME_PREVIEWS[t.key];
                      const isActive = config.theme === t.key;
                      return (
                        <button key={t.key || `theme-${idx}`}
                          onClick={() => { updateAndSave({ theme: t.key }); applyTheme(t.key as ThemeKey); }}
                          style={{
                            width: 64, borderRadius: 10, overflow: "hidden",
                            border: isActive ? "2px solid var(--accent)" : "2px solid transparent",
                            cursor: "pointer", background: "none", padding: 0,
                            boxShadow: isActive ? "0 0 0 3px var(--accent-light)" : "0 2px 6px rgba(0,0,0,0.08)",
                            transition: "all 0.2s", fontFamily: "inherit",
                          }}>
                          <div style={{
                            height: 24, background: prev.barBg, display: "flex",
                            alignItems: "center", padding: "0 6px", gap: 3,
                            borderBottom: `1px solid ${prev.lineBg}`,
                          }}>
                            <div style={{ width: 6, height: 6, borderRadius: "50%", background: prev.accent }} />
                            <div style={{ fontSize: 8, color: prev.text }}>{t.displayName}</div>
                          </div>
                          <div style={{
                            height: 36, background: prev.bodyBg, padding: 6,
                            display: "flex", flexDirection: "column", gap: 3,
                          }}>
                            <div style={{ height: 5, borderRadius: 3, background: prev.barBg, width: "100%", border: `1px solid ${prev.lineBg}` }} />
                            <div style={{ height: 5, borderRadius: 3, background: prev.lineBg, width: "70%" }} />
                            <div style={{ height: 5, borderRadius: 3, background: prev.accent, width: "45%" }} />
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className={styles.sRow}>
                  <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #8B5CF6, #AF52DE)" }}>📑</span>
                  <div className={`${styles.sRowBody}`}>
                    <div className={`${styles.sRowLabel}`}>标签样式</div>
                    <div className={`${styles.sRowDesc}`}>切换筛选标签的显示风格</div>
                  </div>
                  <button className={styles.sVal} onClick={() => handleSwitchTabStyle(tabStyle === "segmented" ? "circle" : "segmented")}>
                    {tabStyle === "segmented" ? "分段控件" : "圆形图标"}
                  </button>
                </div>

                {/* ── 通用 ── */}
                <div className={styles.sSection}>通用</div>
                <div className={styles.sRow}>
                  <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #F59E0B, #FF9500)" }}>🗑</span>
                  <div className={`${styles.sRowBody}`}>
                    <div className={`${styles.sRowLabel}`}>
                      自动清理
                      <HelpTooltip
                        tooltip="建议开启，避免数据库无限膨胀影响性能"
                        detailTitle="自动清理"
                        detail={<>
                          <p>定期删除超过指定天数的旧记录，避免数据库过大。</p>
                          <p>📌 <b>推荐 30 天</b>：平衡存储空间和历史追溯</p>
                          <p>⚠️ 设为「关」则不自动清理，需手动管理</p>
                          <p>💡 清理后可 Ctrl+Z 撤销</p>
                        </>}
                      />
                    </div>
                    <div className={`${styles.sRowDesc}`}>手动清理时，删除超过天数的记录</div>
                  </div>
                  <div className={styles.sCleanup}>
                    {CLEANUP_OPTIONS.map((opt, idx) => (
                      <button key={`cleanup-${opt.value ?? idx}`}
                        className={`${styles.sCleanupOpt}${cleanupDays === opt.value ? ` ${styles.active}` : ""}`}
                        onClick={() => updateAndSave({ auto_cleanup_days: opt.value })}>
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <ToggleRow icon={<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.6 8.6 18 18M15.4 8.6 6 18"/></svg>} gradient="linear-gradient(135deg, #10B981, #34C759)" label="自动去除空白" desc="复制时去除首尾空白字符" value={config.auto_strip} onChange={(v) => updateAndSave({ auto_strip: v })}
                  tooltip="粘贴代码时尤其有用，避免多余缩进"
                  detailTitle="自动去除空白"
                  detail={<>
                    <p>复制文本时自动去除首尾的空格、换行等空白字符。</p>
                    <p>📌 <b>适合场景</b>：复制代码、复制网页文字</p>
                    <p>💡 开启后粘贴更干净，无需手动删空格</p>
                  </>}
                />
                <div className={styles.sRow}>
                  <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #8B5CF6, #AF52DE)" }}>👆</span>
                  <div className={`${styles.sRowBody}`}>
                    <div className={`${styles.sRowLabel}`}>
                      双击列表行为
                      <HelpTooltip
                        tooltip="设为「复制」更快捷，设为「预览」可查看详情"
                        detailTitle="双击行为"
                        detail={<>
                          <p>设置双击卡片时的默认操作。</p>
                          <p>📌 <b>复制</b>：双击直接复制内容到剪贴板</p>
                          <p>📌 <b>预览</b>：双击弹出预览面板，可查看详情或编辑</p>
                          <p>💡 设为「预览」后仍可通过悬停卡片快速复制</p>
                        </>}
                      />
                    </div>
                    <div className={`${styles.sRowDesc}`}>{config.double_click_action === "copy" ? "双击复制到剪贴板" : "双击预览/编辑"}</div>
                  </div>
                  <button className={styles.sVal} onClick={() => updateAndSave({ double_click_action: config.double_click_action === "copy" ? "preview" : "copy" })}>
                    {config.double_click_action === "copy" ? "复制" : "预览"}
                  </button>
                </div>
                <ToggleRow
                  icon="💬"
                  gradient="linear-gradient(135deg, #8B5CF6, #6366F1)"
                  label="悬停预览气泡"
                  desc="鼠标悬停卡片时弹出预览气泡（关闭后仅通过双击查看详情）"
                  value={config.hover_preview_enabled}
                  onChange={(v) => updateAndSave({ hover_preview_enabled: v })}
                  recommend
                  tooltip="推荐开启，快速浏览长文本内容"
                  detailTitle="悬停预览气泡"
                  detail={<>
                    <p>鼠标悬停在卡片上时弹出内容预览气泡。</p>
                    <p>📌 <b>适合</b>：快速浏览长文本、图片预览</p>
                    <p>❌ <b>关闭后</b>：需双击卡片才能查看详情</p>
                    <p>💡 <b>建议开启</b>，大幅提升浏览效率</p>
                  </>}
                />
                <ToggleRow icon="🔁" gradient="linear-gradient(135deg, #06B6D4, #0078D4)" label="依次粘贴循环" desc="到达末尾后从头开始" value={config.sequential_loop} onChange={(v) => updateAndSave({ sequential_loop: v })}
                  tooltip="适合重复粘贴同一组内容时使用"
                />
                <ToggleRow icon="👁" gradient="linear-gradient(135deg, #EF4444, #FF3B30)" label="失焦自动隐藏" desc="窗口失去焦点时隐藏到托盘" value={config.hide_on_focus_out} onChange={(v) => updateAndSave({ hide_on_focus_out: v })}
                  recommend
                  tooltip="点击其他窗口时自动隐藏，保持桌面整洁"
                  detailTitle="失焦自动隐藏"
                  detail={<>
                    <p>当 PastePanda 窗口失去焦点时自动隐藏到托盘。</p>
                    <p>📌 点击其他应用 → 窗口自动收起，不挡视线</p>
                    <p>💡 <b>推荐开启</b>，保持桌面整洁</p>
                    <p>⚠️ 关闭后需手动点击 X 隐藏窗口</p>
                  </>}
                />
                <ToggleRow icon="📌" gradient="linear-gradient(135deg, #F59E0B, #FF9500)" label="窗口置顶" desc="始终显示在其他窗口之上" value={config.always_on_top}
                  tooltip="适合频繁粘贴时使用，窗口始终可见"
                  onChange={async (v) => {
                    await updateAndSave({ always_on_top: v });
                    try { const { getCurrentWindow } = await import("@tauri-apps/api/window"); await getCurrentWindow().setAlwaysOnTop(v); } catch { toast("窗口置顶设置失败", "error"); }
                  }} />
                <ToggleRow icon="🚀" gradient="linear-gradient(135deg, #3B82F6, #0078D4)" label="开机自启" desc="Windows 启动时自动运行" value={config.auto_startup}
                  tooltip="开机后自动在后台运行，托盘图标常驻"
                  detailTitle="开机自启"
                  detail={<>
                    <p>Windows 启动时自动运行 PastePanda。</p>
                    <p>📌 启动后自动最小化到托盘，不影响开机速度</p>
                    <p>💡 <b>推荐开启</b>，不用担心忘记启动</p>
                  </>}
                  onChange={async (v) => {
                    await updateAndSave({ auto_startup: v });
                    try { const { invoke } = await import("@tauri-apps/api/core"); await invoke("set_startup", { enable: v }); } catch { toast("开机自启设置失败", "error"); }
                  }} />

                {/* ── 局域网同步 ── */}
                <div className={styles.sSection}>局域网同步</div>
                <ToggleRow icon="🌐" gradient="linear-gradient(135deg, #06B6D4, #3B82F6)" label="局域网同步" desc="同一局域网内自动同步剪贴板内容" value={config.lan_sync_enabled}
                  detailTitle="局域网同步"
                  detail={<>
                    <p>同一 WiFi 下的多台电脑自动共享剪贴板。</p>
                    <p>📌 <b>场景</b>：台式机复制 → 笔记本粘贴</p>
                    <p>⚠️ <b>注意</b>：两台设备都需安装 PastePanda 并开启此功能</p>
                    <p>💡 <b>适合</b>：多设备办公用户</p>
                  </>}
                  onChange={async (v) => {
                    await updateAndSave({ lan_sync_enabled: v });
                    try {
                      const { invoke } = await import("@tauri-apps/api/core");
                      await invoke("toggle_lan_sync", { enable: v });
                      toast(v ? "局域网同步已开启" : "局域网同步已关闭", "success");
                    } catch (e) { logger.warn("切换LAN同步失败", e); }
                  }} />
                {config.lan_sync_enabled && (
                  <LanSyncPanel toast={toast} />
                )}

                {/* ── 快捷键 ── */}
                <div className={styles.sSection}>快捷键</div>
                <div className={styles.sRow}>
                  <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #3B82F6, #0078D4)" }}>⌨</span>
                  <div className={`${styles.sRowBody}`}>
                    <div className={`${styles.sRowLabel}`}>唤出窗口</div>
                    <div className={`${styles.sRowDesc}`}>全局快捷键，在任何位置唤出</div>
                  </div>
                  <HotkeyRecorder value={config.hotkey} onChange={async (v) => {
                    const oldVal = config.hotkey;
                    await updateAndSave({ hotkey: v });
                    try {
                      const { invoke } = await import("@tauri-apps/api/core");
                      await invoke("reregister_hotkeys");
                      toast("快捷键已更新", "success");
                    } catch {
                      await updateAndSave({ hotkey: oldVal });
                      toast("快捷键无效，已恢复原值", "error");
                    }
                  }} />
                </div>
                <div className={styles.sRow}>
                  <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #8B5CF6, #5856D6)" }}>📋</span>
                  <div className={`${styles.sRowBody}`}>
                    <div className={`${styles.sRowLabel}`}>依次粘贴</div>
                    <div className={`${styles.sRowDesc}`}>按顺序逐条粘贴剪贴板</div>
                  </div>
                  <HotkeyRecorder value={config.sequential_hotkey || "ctrl+q"} onChange={async (v) => {
                    const oldVal = config.sequential_hotkey || "ctrl+q";
                    await updateAndSave({ sequential_hotkey: v });
                    try {
                      const { invoke } = await import("@tauri-apps/api/core");
                      await invoke("reregister_hotkeys");
                      toast("快捷键已更新", "success");
                    } catch {
                      await updateAndSave({ sequential_hotkey: oldVal });
                      toast("快捷键无效，已恢复原值", "error");
                    }
                  }} />
                </div>

                {/* ── 数据管理 ── */}
                <div className={styles.sSection}>数据管理</div>
                <div className={styles.sRow}>
                  <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #F59E0B, #FF9500)" }}>📦</span>
                  <div className={`${styles.sRowBody}`}>
                    <div className={`${styles.sRowLabel}`}>导出数据</div>
                    <div className={`${styles.sRowDesc}`}>将历史记录导出为 JSON 文件</div>
                  </div>
                  <button className={styles.sAction} onClick={handleExport}>导出</button>
                </div>
                <div className={styles.sRow}>
                  <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #06B6D4, #0078D4)" }}>📥</span>
                  <div className={`${styles.sRowBody}`}>
                    <div className={`${styles.sRowLabel}`}>导入数据</div>
                    <div className={`${styles.sRowDesc}`}>从 JSON 文件导入历史记录</div>
                  </div>
                  <button className={styles.sAction} onClick={handleImport}>导入</button>
                </div>
                <div className={styles.sRow}>
                  <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #EF4444, #FF3B30)" }}>🧹</span>
                  <div className={`${styles.sRowBody}`}>
                    <div className={`${styles.sRowLabel}`}>清理过期记录</div>
                    <div className={`${styles.sRowDesc}`}>{expiredCount > 0 ? `${expiredCount} 条记录已过期` : "暂无过期记录"}</div>
                  </div>
                  <button className={`${styles.sAction}${expiredCount > 0 ? ` ${styles.danger}` : ""}`} onClick={handleCleanup}>
                    {expiredCount > 0 ? `清理 ${expiredCount} 条` : "无过期"}
                  </button>
                </div>
              </motion.div>
            )}

            {activeTab === "help" && (
              <motion.div key="tab-help" variants={tabPanelVariants} initial="initial" animate="animate" exit="exit" transition={tabPanelTransition} style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
                <HelpTabContent config={config} appName={appName} appVersion={appVersion} />
              </motion.div>
            )}

            {activeTab === "about" && (
              <motion.div key="tab-about" variants={tabPanelVariants} initial="initial" animate="animate" exit="exit" transition={tabPanelTransition} style={{ flex: 1 }}>
                <AboutTabContent appName={appName} appVersion={appVersion} />
              </motion.div>
            )}
              </AnimatePresence>
            </div>

            {/* Footer */}
            <div className={styles.sFooter}>
              <button onClick={onClose} className={styles.sSaveBtn}>
                关闭设置
              </button>
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

/* ===== Toggle Row 组件 ===== */
function ToggleRow({ icon, gradient, label, desc, value, onChange, tooltip, detailTitle, detail, recommend }: {
  icon: React.ReactNode; gradient: string; label: string; desc: string; value: boolean; onChange: (v: boolean) => void;
  tooltip?: string; detailTitle?: string; detail?: React.ReactNode; recommend?: boolean;
}) {
  return (
    <div className={styles.sRow} onClick={() => onChange(!value)} style={{ cursor: "pointer" }}>
      <span className={`${styles.sRowIcon}`} style={{ background: gradient }}>{icon}</span>
      <div className={`${styles.sRowBody}`}>
        <div className={`${styles.sRowLabel}`}>
          {label}
          {recommend && <span className={`${styles.sRowRecommend}`}>⭐推荐</span>}
          {(tooltip || detail) && (
            <HelpTooltip tooltip={tooltip} detailTitle={detailTitle} detail={detail} />
          )}
        </div>
        <div className={`${styles.sRowDesc}`}>{desc}</div>
      </div>
      <button className={`${styles.sToggle} ${value ? styles.on : styles.off}`}
        onClick={(e) => { e.stopPropagation(); onChange(!value); }}>
        <span className={styles.sToggleThumb} />
        <span className={styles.sToggleLabel}>{value ? "开" : "关"}</span>
      </button>
    </div>
  );
}

/* ===== Hotkey Recorder 组件 ===== */
function HotkeyRecorder({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [recording, setRecording] = useState(false);

  // 全局 keydown 捕获（用于阻止浏览器默认行为，如 F1/Tab/Space）
  useEffect(() => {
    if (!recording) return;
    const handler = (e: KeyboardEvent) => {
      // 阻止功能键/特殊键的浏览器默认行为
      const blocked = ["Tab", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12", " "];
      if (blocked.includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", handler, true); // capture phase
    return () => window.removeEventListener("keydown", handler, true);
  }, [recording]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!recording) return;
      e.preventDefault();
      e.stopPropagation();
      const parts: string[] = [];
      if (e.ctrlKey) parts.push("ctrl");
      if (e.shiftKey) parts.push("shift");
      if (e.altKey) parts.push("alt");
      if (e.metaKey) parts.push("meta");
      const rawKey = e.key;
      // 跳过纯修饰键
      if (["control", "shift", "alt", "meta"].includes(rawKey.toLowerCase())) return;
      // 映射特殊键名
      const keyMap: Record<string, string> = {
        " ": "space", "Spacebar": "space",
        "Tab": "tab",
        "Escape": "esc", "Esc": "esc",
        "Enter": "return", "Return": "return",
        "Backspace": "backspace",
        "Delete": "delete",
        "Home": "home", "End": "end",
        "PageUp": "pageup", "PageDown": "pagedown",
        "ArrowUp": "up", "ArrowDown": "down",
        "ArrowLeft": "left", "ArrowRight": "right",
        "Insert": "insert",
        "CapsLock": "capslock",
        "PrintScreen": "printscreen",
        "ScrollLock": "scrolllock",
        "Pause": "pause",
        "ContextMenu": "contextmenu",
        "NumLock": "numlock",
      };
      // 处理 F1-F24
      let mappedKey: string;
      if (/^F\d{1,2}$/i.test(rawKey)) {
        mappedKey = rawKey.toLowerCase();
      } else {
        mappedKey = keyMap[rawKey] || rawKey.toLowerCase();
      }
      parts.push(mappedKey);
      onChange(parts.join("+"));
      setRecording(false);
    },
    [recording, onChange],
  );

  return (
    <button
      onClick={(e) => { e.stopPropagation(); setRecording(true); }}
      onKeyDown={handleKeyDown}
      onBlur={() => setRecording(false)}
      className={`${styles.sKbd}${recording ? ` ${styles.recording}` : ""}`}>
      {recording ? "按下组合键..." : value}
    </button>
  );
}

/* ===== 帮助 Tab 内容组件 ===== */
/** 将 "ctrl+shift+v" 格式化为胶囊 */
function KeyCaps({ value }: { value: string }) {
  const parts = value.split("+").map((p) => {
    const t = p.trim();
    if (t.length === 1) return t.toUpperCase();
    return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  });
  return (
    <span className={helpStyles.hKey}>
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && <span className="plus">+</span>}
          {p}
        </span>
      ))}
    </span>
  );
}

function StaticKey({ children }: { children: string }) {
  return <span className={helpStyles.hKey}>{children}</span>;
}

function KeyRow({ desc, value, isStatic, hidden }: { desc: string; value: string; isStatic?: boolean; hidden?: boolean }) {
  return (
    <div className={`${helpStyles.h2Row}${hidden ? ` ${helpStyles.h2Hidden}` : ""}`}>
      <span className={helpStyles.h2Desc}>{desc}</span>
      {isStatic ? <StaticKey>{value}</StaticKey> : <KeyCaps value={value} />}
    </div>
  );
}

function SubTitle({ children, hidden }: { children: string; hidden?: boolean }) {
  return <div className={`${helpStyles.h2SubTitle}${hidden ? ` ${helpStyles.h2Hidden}` : ""}`}>{children}</div>;
}

function TipItem({ children, hidden }: { children: React.ReactNode; hidden?: boolean }) {
  return <div className={`${helpStyles.h2Tip}${hidden ? ` ${helpStyles.h2Hidden}` : ""}`}>{children}</div>;
}

function matches(q: string, ...texts: (string | undefined)[]) {
  if (!q) return false;
  const lower = q.toLowerCase();
  return texts.some(t => t?.toLowerCase().includes(lower));
}

function Section({
  icon, iconBg, title, defaultExpanded, forceExpand, hasMatch, children
}: {
  icon: React.ReactNode; iconBg: string; title: string; defaultExpanded?: boolean; forceExpand: boolean; hasMatch: boolean; children: React.ReactNode;
}) {
  const [manualExpanded, setManualExpanded] = useState(defaultExpanded ?? false);
  const expanded = forceExpand ? true : manualExpanded;
  if (forceExpand && !hasMatch) return null;
  return (
    <div className={`${helpStyles.h2Section}${expanded ? ` ${helpStyles.expanded}` : ""}`}>
      <div className={helpStyles.h2SectionHeader} onClick={() => !forceExpand && setManualExpanded(!manualExpanded)}>
        <span className={helpStyles.h2SectionIcon} style={{ background: iconBg }}>{icon}</span>
        <span className={helpStyles.h2SectionTitle}>{title}</span>
        <ChevronRight size={12} className={helpStyles.h2Arrow} />
      </div>
      <div className={helpStyles.h2SectionContent}>
        <div className={helpStyles.h2SectionInner}>{children}</div>
      </div>
    </div>
  );
}

function HelpTabContent({ config, appName, appVersion }: { config: AppConfig; appName: string; appVersion: string }) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setQuery("");
    setTimeout(() => searchRef.current?.focus(), 100);
  }, []);

  const hotkeyShow = (config.hotkey as string) || "ctrl+shift+v";
  const hotkeySeq = (config.sequential_hotkey as string) || "ctrl+q";
  const hotkeySelectAll = (config.select_all_hotkey as string) || "ctrl+a";

  const q = query.trim();
  const searching = q.length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* Search bar */}
      <div className={helpStyles.h2SearchBar}>
        <div className={helpStyles.h2SearchWrap}>
          <Search size={13} className={helpStyles.h2SearchIcon} />
          <input
            ref={searchRef}
            type="text"
            className={helpStyles.h2SearchInput}
            placeholder="搜索快捷键、功能…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); }}
          />
          {searching && (
            <button className={helpStyles.h2SearchClear} onClick={() => { setQuery(""); searchRef.current?.focus(); }}>
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className={`dialog-body ${helpStyles.h2Body}`}>
        {/* 1. 快捷键速查 */}
        <Section icon={<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h8M6 12h.01M18 12h.01M6 16h12"/></svg>} iconBg="linear-gradient(135deg, #3B82F6, #0078D4)" title="快捷键速查" defaultExpanded
          forceExpand={searching} hasMatch={!searching || matches(q, "唤出 隐藏 窗口", "隐藏 Esc", "设置 ctrl+s", "帮助 ctrl+h", "片段库 ctrl+b", "内容提取 ctrl+e", "导航 上下 ↑ ↓", "顶部 底部 Home End", "粘贴 Enter", "预览 Space", "删除 Delete", "右键 Shift F10", "全选 ctrl+a", "置顶 ctrl+d", "撤销 ctrl+z", "多选 ctrl click", "范围 shift click", "依次粘贴 ctrl+q", "粘贴第N ctrl alt 1 9")}>
          <SubTitle hidden={searching && !matches(q, "唤出 隐藏 窗口", "隐藏 Esc", "设置 ctrl+s", "帮助 ctrl+h", "片段库 ctrl+b", "内容提取 ctrl+e")}>全局操作</SubTitle>
          <KeyRow desc="唤出 / 隐藏窗口" value={hotkeyShow} hidden={searching && !matches(q, "唤出 隐藏 窗口", hotkeyShow)} />
          <KeyRow desc="隐藏窗口" value="Esc" isStatic hidden={searching && !matches(q, "隐藏 Esc", "窗口")} />
          <KeyRow desc="打开设置" value="ctrl+s" hidden={searching && !matches(q, "设置 ctrl+s")} />
          <KeyRow desc="打开帮助" value="ctrl+h" hidden={searching && !matches(q, "帮助 ctrl+h")} />
          <KeyRow desc="打开片段库" value="ctrl+b" hidden={searching && !matches(q, "片段库 ctrl+b")} />
          <KeyRow desc="打开内容提取" value="ctrl+e" hidden={searching && !matches(q, "内容提取 ctrl+e")} />

          <SubTitle hidden={searching && !matches(q, "导航 上下 ↑ ↓", "顶部 底部 Home End", "粘贴 Enter", "预览 Space", "删除 Delete", "右键 Shift F10", "全选 ctrl+a", "置顶 ctrl+d", "撤销 ctrl+z")}>列表操作</SubTitle>
          <KeyRow desc="上下导航记录" value="↑ / ↓" isStatic hidden={searching && !matches(q, "导航 上下 ↑ ↓")} />
          <KeyRow desc="跳到顶部 / 底部" value="Home / End" isStatic hidden={searching && !matches(q, "顶部 底部 Home End")} />
          <KeyRow desc="粘贴选中记录" value="Enter" isStatic hidden={searching && !matches(q, "粘贴 Enter 选中")} />
          <KeyRow desc="快速预览内容" value="Space" isStatic hidden={searching && !matches(q, "预览 Space 内容")} />
          <KeyRow desc="删除选中记录" value="Delete" isStatic hidden={searching && !matches(q, "删除 Delete")} />
          <KeyRow desc="打开右键菜单" value="Shift + F10" isStatic hidden={searching && !matches(q, "右键 Shift F10 菜单")} />
          <KeyRow desc="全选" value={hotkeySelectAll} hidden={searching && !matches(q, "全选 ctrl+a", hotkeySelectAll)} />
          <KeyRow desc="置顶 / 取消置顶" value="ctrl+d" hidden={searching && !matches(q, "置顶 ctrl+d")} />
          <KeyRow desc="撤销删除" value="ctrl+z" hidden={searching && !matches(q, "撤销 ctrl+z")} />

          <SubTitle hidden={searching && !matches(q, "多选 ctrl click", "范围 shift click")}>多选操作</SubTitle>
          <KeyRow desc="逐个多选" value="ctrl+click" hidden={searching && !matches(q, "多选 ctrl click")} />
          <KeyRow desc="范围选择" value="shift+click" hidden={searching && !matches(q, "范围 shift click")} />

          <SubTitle hidden={searching && !matches(q, "依次粘贴 ctrl+q", "粘贴第N ctrl alt 1 9")}>高级功能</SubTitle>
          <KeyRow desc="依次粘贴模式" value={hotkeySeq} hidden={searching && !matches(q, "依次粘贴", hotkeySeq)} />
          <KeyRow desc="粘贴第 N 条" value="ctrl+alt+1~9" hidden={searching && !matches(q, "粘贴第N ctrl alt 1 9")} />
        </Section>

        {/* 2. 功能说明与设置 */}
        <Section icon="🧩" iconBg="linear-gradient(135deg, #8B5CF6, #5856D6)" title="功能说明与设置"
          forceExpand={searching} hasMatch={!searching || matches(q, "功能 指南 设置 说明", "主题 清理 同步 粘贴", "图片 OCR 片段 库", "空间 数据 管理 托盘")}>
          <div style={{ padding: "4px 0", fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.7 }}>
            <p style={{ margin: "0 0 8px" }}>
              各功能的详细说明和设置项说明已移至 <strong>设置页面</strong>。
            </p>
            <p style={{ margin: "0 0 4px" }}>
              📌 打开设置（Ctrl+S），点击各选项旁的 <span style={{ color: "var(--accent)", fontWeight: 600 }}>?</span> 图标查看详情。
            </p>
            <p style={{ margin: 0 }}>
              💡 也可以在此搜索框搜索功能关键词快速定位。
            </p>
          </div>
        </Section>

        {/* 3. 技巧提示 */}
        <Section icon="💡" iconBg="linear-gradient(135deg, #10B981, #34C759)" title="技巧提示"
          forceExpand={searching} hasMatch={!searching || matches(q, "Ctrl Click 多选", "Shift Click 范围", "Space 预览", "双击 卡片 配置", "Ctrl Z 撤销", "Ctrl Alt 1 9", "置顶 固定", "搜索 过滤")}>
          <TipItem hidden={searching && !matches(q, "Ctrl Click 多选", "批量 删除")}>
            <span className={helpStyles.h2TipBulb}>💡</span>
            <span className={helpStyles.h2TipText}><strong>Ctrl + Click</strong> 可逐个多选记录，然后批量删除或操作</span>
          </TipItem>
          <TipItem hidden={searching && !matches(q, "Shift Click 范围", "选择")}>
            <span className={helpStyles.h2TipBulb}>💡</span>
            <span className={helpStyles.h2TipText}><strong>Shift + Click</strong> 可范围选择，从当前到点击位置全部选中</span>
          </TipItem>
          <TipItem hidden={searching && !matches(q, "Space 预览", "内容")}>
            <span className={helpStyles.h2TipBulb}>💡</span>
            <span className={helpStyles.h2TipText}>按 <strong>Space</strong> 快速预览选中内容，无需打开详情</span>
          </TipItem>
          <TipItem hidden={searching && !matches(q, "双击 卡片", "配置")}>
            <span className={helpStyles.h2TipBulb}>💡</span>
            <span className={helpStyles.h2TipText}>双击卡片行为可在设置中配置（粘贴/预览/复制）</span>
          </TipItem>
          <TipItem hidden={searching && !matches(q, "Ctrl Z 撤销", "误删 恢复")}>
            <span className={helpStyles.h2TipBulb}>💡</span>
            <span className={helpStyles.h2TipText}>误删记录可按 <strong>Ctrl + Z</strong> 立即撤销恢复</span>
          </TipItem>
          <TipItem hidden={searching && !matches(q, "Ctrl Alt 1 9", "序号 粘贴")}>
            <span className={helpStyles.h2TipBulb}>💡</span>
            <span className={helpStyles.h2TipText}><strong>Ctrl + Alt + 1~9</strong> 直接粘贴对应序号的记录，无需打开窗口</span>
          </TipItem>
          <TipItem hidden={searching && !matches(q, "置顶 固定", "常用")}>
            <span className={helpStyles.h2TipBulb}>💡</span>
            <span className={helpStyles.h2TipText}>置顶记录会始终显示在列表顶部，适合固定常用内容</span>
          </TipItem>
          <TipItem hidden={searching && !matches(q, "搜索 过滤", "关键词 类型")}>
            <span className={helpStyles.h2TipBulb}>💡</span>
            <span className={helpStyles.h2TipText}>搜索框支持关键词过滤，输入即搜，支持类型筛选</span>
          </TipItem>
        </Section>

        {searching && (
          <div className={helpStyles.h2NoResults}>未找到匹配内容</div>
        )}
      </div>
    </div>
  );
}

/* ===== 关于 Tab 内容组件 ===== */
const TECH_STACK = [
  { label: "Tauri 2", desc: "桌面框架", color: "#FFC131", icon: "⚙️" as React.ReactNode },
  { label: "React 19", desc: "UI 框架", color: "#61DAFB", icon: "⚛️" as React.ReactNode },
  { label: "TypeScript", desc: "类型安全", color: "#3178C6", icon: <svg viewBox="0 0 24 24" width="18" height="18"><rect width="24" height="24" rx="3" fill="#3178C6"/><text x="12" y="17" textAnchor="middle" fontSize="11" fontWeight="700" fill="#fff" fontFamily="system-ui">TS</text></svg> as React.ReactNode },
  { label: "SQLite", desc: "本地存储", color: "#4DB8BD", icon: "🗄️" as React.ReactNode },
  { label: "Rust", desc: "后端核心", color: "#DEA584", icon: "🦀" as React.ReactNode },
  { label: "Vite", desc: "构建工具", color: "#646CFF", icon: "⚡" as React.ReactNode },
] as const;

function useVersionStatus() {
  const { status, update } = useUpdate();
  return useMemo(() => {
    switch (status) {
      case "checking":
        return { label: "检查中…", cls: "update", dotCls: "orange" };
      case "available":
        return { label: `v${update?.version ?? "?"} 可用`, cls: "update", dotCls: "orange" };
      case "downloading":
        return { label: "下载中…", cls: "update", dotCls: "orange" };
      case "ready":
      case "installed":
        return { label: "就绪", cls: "latest", dotCls: "green" };
      case "error":
        return { label: "错误", cls: "update", dotCls: "orange" };
      case "idle":
      default:
        return { label: "已是最新", cls: "latest", dotCls: "green" };
    }
  }, [status, update]);
}

function AboutTabContent({ appName, appVersion }: { appName: string; appVersion: string }) {
  const versionStatus = useVersionStatus();

  const handleOpenProject = async () => {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl("https://github.com/lzlkyb/pastepanda");
    } catch (e) {
      console.warn("打开项目主页失败", e);
    }
  };

  return (
    <div className="dialog-body" style={{ "--dialog-body-padding": "28px 28px 24px" } as React.CSSProperties}>
      {/* 英雄区 */}
      <div className={aboutStyles.aboutHero}>
        <div className={aboutStyles.aboutIcon}><AppIcon size={64} /></div>
        <div className={aboutStyles.aboutMeta}>
          <div className={aboutStyles.aboutName}>{appName}</div>
          <div className={aboutStyles.aboutVersionRow}>
            <VersionBadge version={appVersion} />
            <span className={`${aboutStyles.aboutVersionStatus} ${aboutStyles[versionStatus.cls]}`}>
              <span className={`${aboutStyles.aboutStatusDot} ${aboutStyles[versionStatus.dotCls]}`} />
              {versionStatus.label}
            </span>
          </div>
        </div>
      </div>

      {/* 分割线 */}
      <div className={aboutStyles.aboutDivider} />

      {/* 技术栈 */}
      <div className={aboutStyles.aboutSectionLabel}>技术栈</div>
      <div className={aboutStyles.aboutTechGrid}>
        {TECH_STACK.map((t) => (
          <div key={t.label} className={aboutStyles.aboutTechCard}>
            <div className={aboutStyles.aboutTechIcon} style={{ background: `${t.color}20`, color: t.color }}>
              {t.icon}
            </div>
            <div className={aboutStyles.aboutTechInfo}>
              <div className={aboutStyles.aboutTechName}>{t.label}</div>
              <div className={aboutStyles.aboutTechDesc}>{t.desc}</div>
            </div>
          </div>
        ))}
      </div>

      {/* 更新横幅 */}
      <UpdateBanner />

      {/* 底部 */}
      <div className={aboutStyles.aboutFooter}>
        <button className={aboutStyles.aboutFooterLink} onClick={handleOpenProject}>
          <ExternalLink size={14} />
          项目主页
        </button>
        <span className={aboutStyles.aboutCopyright}>© 2026 {appName}</span>
      </div>
    </div>
  );
}

/* ===== LAN 同步面板组件 ===== */
interface LanDevice { device_id: string; device_name: string; last_seen: string; }

function LanSyncPanel({ toast }: { toast: (msg: string, type?: "success" | "error" | "info", duration?: number) => void }) {
  const [devices, setDevices] = useState<LanDevice[]>([]);
  const [loading, setLoading] = useState(false);

  const refreshDevices = useCallback(async () => {
    setLoading(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const list = await invoke<LanDevice[]>("get_lan_devices");
      setDevices(list);
    } catch (e) { logger.warn("获取设备列表失败", e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    refreshDevices();
    const timer = setInterval(refreshDevices, 5000);
    return () => clearInterval(timer);
  }, [refreshDevices]);

  const handleSendTest = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("send_lan_test");
      toast("已发送测试同步消息", "success");
    } catch (e) { logger.warn("发送测试失败", e); }
  };

  return (
    <div className={styles.lanPanel}>
      <div className={`${styles.lanPanelHeader}`}>
        <div className={styles.lanStatus}>
          <div className={styles.lanDot} />
          <span className={`${styles.lanStatusText}`}>监听中 — 等待其他设备连接</span>
        </div>
        <button className={styles.lanRefreshBtn} onClick={refreshDevices} disabled={loading}>
          {loading ? "⏳" : "🔄"} 刷新
        </button>
      </div>

      {/* 设备列表 */}
      {devices.length > 0 && (
        <div className={styles.lanDeviceList}>
          {devices.map((d, idx) => (
            <div key={d.device_id ? `device-${d.device_id}-${idx}` : `device-${idx}`} className={`${styles.lanDeviceItem}`}>
              <div className={`${styles.lanDeviceAvatar}`} style={{
                background: `hsl(${d.device_id.charCodeAt(0) * 40 % 360}, 60%, 55%)`,
              }}>
                {d.device_name.charAt(0).toUpperCase()}
              </div>
              <div className={`${styles.lanDeviceInfo}`}>
                <div className={`${styles.lanDeviceName}`}>{d.device_name}</div>
                <div className={`${styles.lanDeviceTime}`}>{d.last_seen}</div>
              </div>
              <span className={`${styles.lanDeviceOnline}`} title="在线"><span className={styles.dotOnline} /></span>
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 8 }}>
        💡 同一局域网内的设备将自动发现并同步剪贴板
        {devices.length > 0 && <span> · 已发现 {devices.length} 台设备</span>}
      </div>
      <button className={styles.lanTestBtn} onClick={handleSendTest}>
        🔔 发送测试消息
      </button>
    </div>
  );
}
