import { useState, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { useAppStore, HistoryItem } from "@/stores/appStore";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { VersionBadge } from "@/components/VersionBadge";
import { HelpTooltip } from "@/components/HelpTooltip";
import { THEMES, applyTheme, ThemeKey } from "@/lib/theme";
import { useToast } from "@/components/Toast";
import { logger } from "@/lib/logger";
import { getStats, Stats, getAppVersion, getAppName } from "@/lib/api";
import styles from "./Settings.module.css";

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

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const config = useAppStore((s) => s.config);
  const updateConfig = useAppStore((s) => s.updateConfig);
  const history = useAppStore((s) => s.history);
  const [saved, setSaved] = useState(false);
  const [tabStyle, setTabStyle] = useState<string>(
    () => localStorage.getItem("tabStyle") || "segmented",
  );
  const [stats, setStats] = useState<Stats>({ total: 0, pinned: 0, today: 0, text_count: 0, image_count: 0, file_count: 0, earliest_time: null, db_size_kb: 0 });
  const [appName, setAppName] = useState("PastePanda");
  const [appVersion, setAppVersion] = useState("?.?.?");
  const [showCleanupConfirm, setShowCleanupConfirm] = useState(false);
  const { toast } = useToast();

  // 加载统计数据
  useEffect(() => {
    if (open) {
      getStats(config.current_workspace).then(setStats).catch(() => {});
      getAppVersion().then(setAppVersion);
      getAppName().then(setAppName).catch(() => setAppName("PastePanda"));
    }
  }, [open, config.current_workspace]);

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

  if (!open) return null;

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
            <div className="dialog-header">
              <h2 className="dialog-title">⚙ 设置</h2>
              <button onClick={onClose} className="dialog-close"><X size={16} /></button>
            </div>

            {/* Body */}
            <div className="dialog-body" style={{ padding: 0, gap: 0 }}>

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
