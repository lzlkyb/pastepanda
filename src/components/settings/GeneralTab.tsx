import React from "react";
import { useAppStore, AppConfig, HistoryItem } from "@/stores/appStore";
import { HelpTooltip } from "@/components/HelpTooltip";
import { THEMES, applyTheme, ThemeKey } from "@/lib/theme";
import { useToast } from "@/components/Toast";
import { logger } from "@/lib/logger";
import { Stats } from "@/lib/api";
import { ToggleRow } from "./ToggleRow";
import { HotkeyRecorder } from "./HotkeyRecorder";
import { LanSyncPanel } from "./LanSyncPanel";
import styles from "../Settings.module.css";

const THEME_PREVIEWS: Record<string, { bg: string; accent: string; text: string; barBg: string; bodyBg: string; lineBg: string }> = {
  "ocean":      { bg: "#F4F6F9", accent: "#0284C7", text: "#64748B", barBg: "#fff", bodyBg: "#F4F6F9", lineBg: "#E0E4EB" },
  "ocean-dark": { bg: "#060D14", accent: "#3B9EFF", text: "#8BA4C0", barBg: "#0A1628", bodyBg: "#060D14", lineBg: "#162B45" },
  "midnight":   { bg: "#09090B", accent: "#818CF8", text: "#A1A1AA", barBg: "#18181B", bodyBg: "#09090B", lineBg: "#27272A" },
  "forest":     { bg: "#F2F7F5", accent: "#059669", text: "#78716C", barBg: "#fff", bodyBg: "#F2F7F5", lineBg: "#D1D9D3" },
  "blossom":    { bg: "#FFFBFD", accent: "#EC4899", text: "#A68A96", barBg: "#fff", bodyBg: "#FFFBFD", lineBg: "#F3E8ED" },
  "terminal":   { bg: "#0A0A0A", accent: "#22C55E", text: "#A3A3A3", barBg: "#141414", bodyBg: "#0A0A0A", lineBg: "#262626" },
  "sunset":     { bg: "#1C1410", accent: "#F97316", text: "#B8A99A", barBg: "#281E18", bodyBg: "#1C1410", lineBg: "#3D3028" },
};

const CLEANUP_OPTIONS = [
  { label: "关", value: 0 },
  { label: "7天", value: 7 },
  { label: "15天", value: 15 },
  { label: "30天", value: 30 },
  { label: "60天", value: 60 },
];

interface GeneralTabProps {
  config: AppConfig;
  updateConfig: (partial: Record<string, unknown>) => void;
  updateAndSave: (partial: Record<string, unknown>) => Promise<void>;
  stats: Stats | null;
  history: HistoryItem[];
  tabStyle: string;
  handleSwitchTabStyle: (style: "segmented" | "circle") => void;
  handleExport: () => Promise<void>;
  handleImport: () => Promise<void>;
  handleCleanup: () => Promise<void>;
  exporting?: boolean;
  importing?: boolean;
}

export function GeneralTab({
  config, updateConfig, updateAndSave, stats, history,
  tabStyle, handleSwitchTabStyle,
  handleExport, handleImport, handleCleanup,
  exporting, importing,
}: GeneralTabProps) {
  const { toast } = useToast();
  const cleanupDays = config.auto_cleanup_days;
  const expiredCount = cleanupDays > 0
    ? history.filter((h) => {
        const t = h.time.replace(" ", "T");
        const recordTime = new Date(t).getTime();
        return Date.now() - recordTime > cleanupDays * 86400000;
      }).length
    : 0;

  return (
    <>
      {/* ── 数据统计 ── */}
      <div className={styles.sSection}>数据统计</div>
      <div className={styles.statsPanel}>
        <div className={styles.statsPanelHeader}>
          📊 剪贴板数据概览
        </div>
        {stats ? (
          <>
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
          </>
        ) : (
          <div style={{ padding: "16px 0", textAlign: "center", fontSize: 12, color: "var(--text-muted)", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
            <span style={{ display: "inline-block", width: 14, height: 14, border: "2px solid var(--border-color)", borderTopColor: "var(--accent)", borderRadius: "50%", animation: "fab-icon-spin 0.6s linear infinite" }} />
            加载统计数据…
          </div>
        )}
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
      <div className={styles.sRow}>
        <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #6366F1, #818CF8)" }}>🖱️</span>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>
            卡片悬浮行为
            <span className={`${styles.sRowRecommend}`}>⭐推荐</span>
            <HelpTooltip
              tooltip="鼠标悬停卡片时的交互方式"
              detailTitle="卡片悬浮行为"
              detail={<>
                <p>设置鼠标悬停在卡片上时的交互方式。</p>
                <p>📌 <b>关闭</b>：无悬浮交互，界面最简洁</p>
                <p>📌 <b>操作按钮</b>：Hover 显示复制/收藏/编辑/删除按钮，时间自动隐藏</p>
                <p>📌 <b>预览气泡</b>：弹出 Popover 气泡，内容预览+操作</p>
                <p>💡 <b>推荐气泡模式</b>，适合浏览长文本内容</p>
              </>}
            />
          </div>
          <div className={`${styles.sRowDesc}`}>
            {config.hover_mode === "off" ? "无悬浮交互，界面最简洁" : config.hover_mode === "inline" ? "Hover 显示操作按钮，时间自动隐藏" : "弹出 Popover 预览气泡，内容预览+操作"}
          </div>
        </div>
        <div className={styles.sSegGroup}>
          <button className={`${styles.sSegOpt}${config.hover_mode === "off" ? ` ${styles.sSegActive}` : ""}`} onClick={() => updateAndSave({ hover_mode: "off" })} title="关闭">
            <span className={styles.sSegEmoji}>🚫</span>
          </button>
          <button className={`${styles.sSegOpt}${config.hover_mode === "inline" ? ` ${styles.sSegActive}` : ""}`} onClick={() => updateAndSave({ hover_mode: "inline" })} title="操作按钮">
            <span className={styles.sSegEmoji}>👆</span>
          </button>
          <button className={`${styles.sSegOpt}${config.hover_mode === "popover" ? ` ${styles.sSegActive}` : ""}`} onClick={() => updateAndSave({ hover_mode: "popover" })} title="预览气泡">
            <span className={styles.sSegEmoji}>💬</span>
          </button>
        </div>
      </div>

      {/* 来源图标模式 */}
      <div className={styles.sRow}>
        <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #EC4899, #F43F5E)" }}>🎯</span>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>
            来源图标
            <span className={`${styles.sRowRecommend}`}>⭐推荐</span>
            <HelpTooltip
              tooltip="应用真实图标更直观，首次提取约需 50ms"
              detailTitle="来源图标"
              detail={<>
                <p>控制剪贴板卡片中来源 Badge 的图标显示方式。</p>
                <p>📌 <b>应用图标</b>：提取真实程序图标（推荐，更直观）</p>
                <p>📌 <b>Emoji</b>：使用预设的 emoji 图标</p>
                <p>💡 <b>推荐真实图标</b>，一眼就能识别来源应用</p>
              </>}
            />
          </div>
          <div className={`${styles.sRowDesc}`}>
            {config.source_icon_mode === "app" ? "显示真实程序图标，更直观" : "显示预设 Emoji 图标"}
          </div>
        </div>
        <div className={styles.sSegGroup}>
          <button className={`${styles.sSegOpt}${config.source_icon_mode === "emoji" ? ` ${styles.sSegActive}` : ""}`} onClick={() => updateAndSave({ source_icon_mode: "emoji" })} title="Emoji 图标">
            <span className={styles.sSegEmoji}>😀</span>
          </button>
          <button className={`${styles.sSegOpt}${config.source_icon_mode === "app" ? ` ${styles.sSegActive}` : ""}`} onClick={() => updateAndSave({ source_icon_mode: "app" })} title="应用真实图标">
            <span className={styles.sSegEmoji}>🖼️</span>
          </button>
        </div>
      </div>
      <ToggleRow icon="⏱" gradient="linear-gradient(135deg, #8B5CF6, #6366F1)" label="时间线" desc="主页面左侧显示竖版时间轴导航" value={config.timeline_enabled}
        tooltip="在剪贴板列表左侧显示时间轴，可快速跳转到不同时间段的记录"
        detailTitle="时间线"
        detail={<>
          <p>在主页左侧显示一条竖版时间轴导航条。</p>
          <p>📌 <b>功能</b>：按时间分组（今天/昨天/本周/更早）快速定位剪贴板记录</p>
          <p>🖱️ <b>操作</b>：悬停查看卡片预览，点击跳转到对应位置</p>
          <p>💡 适合记录较多时使用，帮助快速浏览</p>
        </>}
        onChange={(v) => updateAndSave({ timeline_enabled: v })} />
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
          } catch (e) {
            logger.warn("切换LAN同步失败", e);
            toast("局域网同步切换失败，请检查网络", "error");
          }
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
        <button className={styles.sAction} onClick={handleExport} disabled={exporting}>
          {exporting ? <span className={styles.sActionLoading}>导出中…</span> : "导出"}
        </button>
      </div>
      <div className={styles.sRow}>
        <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #06B6D4, #0078D4)" }}>📥</span>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>导入数据</div>
          <div className={`${styles.sRowDesc}`}>从 JSON 文件导入历史记录</div>
        </div>
        <button className={styles.sAction} onClick={handleImport} disabled={importing}>
          {importing ? <span className={styles.sActionLoading}>导入中…</span> : "导入"}
        </button>
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
    </>
  );
}
