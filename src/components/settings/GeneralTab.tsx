import React, { useState, useRef, useLayoutEffect, useCallback, useEffect, useMemo } from "react";
import { AppConfig, useAppStore } from "@/stores/appStore";
import { HelpTooltip } from "@/components/HelpTooltip";
import { THEMES, applyTheme, ThemeKey } from "@/lib/theme";
import { emit } from "@tauri-apps/api/event";
import { useToast } from "@/components/Toast";
import { logger } from "@/lib/logger";
import { StatsDetail } from "@/lib/api";
import { resolveSource, fetchRealSourceIcon } from "@/lib/source-mappings";
import { ToggleRow } from "./ToggleRow";
import { HotkeyRecorder } from "./HotkeyRecorder";
import { LanSyncPanel } from "./LanSyncPanel";
import { DeepCleanDialog } from "@/components/DeepCleanDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import styles from "../Settings.module.css";

const THEME_PREVIEWS: Record<string, { bg: string; accent: string; text: string; barBg: string; bodyBg: string; lineBg: string }> = {
  "ocean":      { bg: "#F4F6F9", accent: "#0284C7", text: "#64748B", barBg: "#fff", bodyBg: "linear-gradient(180deg, #EAF6FD 0%, #CFE9F8 40%, #9ED0EA 75%, #79B8DD 100%)", lineBg: "#E0E4EB" },
  "ocean-dark": { bg: "#060D14", accent: "#3B9EFF", text: "#8BA4C0", barBg: "#0A1628", bodyBg: "radial-gradient(130% 120% at 70% -5%, #14415F 0%, #0A2440 45%, #041225 100%)", lineBg: "#162B45" },
  "midnight":   { bg: "#09090B", accent: "#818CF8", text: "#A1A1AA", barBg: "#18181B", bodyBg: "radial-gradient(100% 80% at 50% -10%, #1C1832 0%, #0B0B13 55%, #07070C 100%)", lineBg: "#27272A" },
  "forest":     { bg: "#F2F7F5", accent: "#059669", text: "#78716C", barBg: "#fff", bodyBg: "linear-gradient(180deg, #F5F1E3 0%, #EAE5D1 55%, #DCD6BD 100%)", lineBg: "#D1D9D3" },
  "blossom":    { bg: "#FFFBFD", accent: "#EC4899", text: "#A68A96", barBg: "#fff", bodyBg: "linear-gradient(160deg, #FFF0F6 0%, #FFDEEE 55%, #F9C6DD 100%)", lineBg: "#F3E8ED" },
  "terminal":   { bg: "#0A0A0A", accent: "#22C55E", text: "#A3A3A3", barBg: "#141414", bodyBg: "radial-gradient(120% 120% at 50% 40%, #0A1408 0%, #000000 75%)", lineBg: "#262626" },
  "sunset":     { bg: "#1C1410", accent: "#F97316", text: "#B8A99A", barBg: "#281E18", bodyBg: "linear-gradient(180deg, #2A1638 0%, #4A2150 38%, #8A3A5C 68%, #D96A5B 88%, #F0925F 100%)", lineBg: "#3D3028" },
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
  stats: StatsDetail | null;
  /** 过期记录数（后端按清理条件精确统计，含"未置顶+超期"） */
  expiredCount: number;
  tabStyle: string;
  handleSwitchTabStyle: (style: "segmented" | "circle") => void;
  handleExport: () => Promise<void>;
  handleImport: () => Promise<void>;
  handleCleanup: () => Promise<void>;
  exporting?: boolean;
  importing?: boolean;
}

/** 来源榜图标：复用侧边栏真实应用图标 / emoji 双模式逻辑（source_icon_mode + realIconCache） */
function SourceRowIcon({ source, sourceIcon, fallbackEmoji, color }: { source: string; sourceIcon?: string | null; fallbackEmoji: string; color?: string }) {
  const sourceIconMode = useAppStore((s) => s.config.source_icon_mode);
  const cacheKey = sourceIcon || source;
  const realIconUrl = useAppStore((s) => s.realIconCache[cacheKey]);

  useEffect(() => {
    if (sourceIconMode === "app" && source) {
      fetchRealSourceIcon(source, sourceIcon);
    }
  }, [source, sourceIcon, sourceIconMode]);

  return (
    <span className={styles.bSrcIco} style={color ? { background: `${color}26` } : undefined}>
      {sourceIconMode === "app" && realIconUrl ? (
        <img src={realIconUrl} alt="" className={styles.bSrcIcoImg} />
      ) : (
        fallbackEmoji
      )}
    </span>
  );
}

export function GeneralTab({
  config, updateConfig, updateAndSave, stats, expiredCount,
  tabStyle, handleSwitchTabStyle,
  handleExport, handleImport, handleCleanup,
  exporting, importing,
}: GeneralTabProps) {
  const { toast } = useToast();
  const cleanupDays = config.auto_cleanup_days;
  // 修复：改保留天数原本点即生效，下一小时静默删一批且自动清理不写撤销栈（见 auto_cleanup.rs）。
  // 变严格时先用已有的 count_expired_history 算出影响条数，弹二次确认（与手动清理同一套模式）。
  // count 为 null 表示统计失败：仍然弹确认（不能因统计失败就静默删），只是不显示具体条数
  const [pendingCleanup, setPendingCleanup] = useState<{ days: number; count: number | null } | null>(null);

  const handlePickCleanupDays = useCallback(async (next: number) => {
    if (next === cleanupDays) return;
    // 关闭清理或把天数改大（变宽松）不会产生新的删除，直接生效
    if (next <= 0 || (cleanupDays > 0 && next > cleanupDays)) {
      await updateAndSave({ auto_cleanup_days: next });
      return;
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const n = await invoke<number>("count_expired_history", {
        workspace: config.current_workspace,
        beforeDays: next,
      });
      if (n > 0) { setPendingCleanup({ days: next, count: n }); return; }
      // 新天数下没有任何记录会被删，无需骚扰用户
      await updateAndSave({ auto_cleanup_days: next });
    } catch (e) {
      logger.warn("统计过期记录数失败", e);
      setPendingCleanup({ days: next, count: null });
    }
  }, [cleanupDays, config.current_workspace, updateAndSave]);

  // 深度清理弹窗开关（数据管理 → 深度清理）
  const [showDeepClean, setShowDeepClean] = useState(false);

  // ── 数据仪表盘：来源 Top 5 折叠状态 + 更新时间 + 派生指标 ──
  const [srcOpen, setSrcOpen] = useState(false);
  const [loadedAt, setLoadedAt] = useState("");
  useEffect(() => {
    if (stats) {
      const d = new Date();
      setLoadedAt(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`);
    }
  }, [stats]);

  /** 仪表盘派生值：今昨涨跌、7 日均、时段峰值、圆环弧长、来源摘要等 */
  const dash = useMemo(() => {
    if (!stats) return null;
    const dailyMax = Math.max(1, ...stats.daily.map((d) => d.count));
    const weekTotal = stats.daily.reduce((s, d) => s + d.count, 0);
    const weekAvg = Math.round(weekTotal / 7);
    const delta =
      stats.yesterday > 0
        ? {
            text: `${stats.today >= stats.yesterday ? "▲" : "▼"} ${Math.abs(((stats.today - stats.yesterday) / stats.yesterday) * 100).toFixed(1)}%`,
            up: stats.today >= stats.yesterday,
          }
        : stats.today > 0
          ? { text: "新增", up: true }
          : null;
    const hourMax = Math.max(...stats.hours);
    const peakHour = hourMax > 0 ? stats.hours.indexOf(hourMax) : -1;
    const typeTotal = stats.text_count + stats.image_count + stats.file_count;
    const C = 2 * Math.PI * 30; // 圆环周长（r=30）
    const arc = (n: number) => (typeTotal > 0 ? (n / typeTotal) * C : 0);
    const textArc = arc(stats.text_count);
    const imageArc = arc(stats.image_count);
    const fileArc = arc(stats.file_count);
    const textPct = typeTotal > 0 ? Math.round((stats.text_count / typeTotal) * 100) : 0;
    const top = stats.sources[0];
    const srcSummary =
      top && stats.total > 0
        ? `${resolveSource(top.source).displayName} ${Math.round((top.count / stats.total) * 100)}% 居首`
        : "";
    const srcMax = top ? Math.max(1, top.count) : 1;
    return { dailyMax, weekTotal, weekAvg, delta, hourMax, peakHour, C, textArc, imageArc, fileArc, textPct, srcSummary, srcMax };
  }, [stats]);

  // ── .md 文件关联：状态以系统注册表为准（实时查询，不存 AppConfig，避免设置与注册表脱节） ──
  type MdAssocStatus = "unregistered" | "registered" | "default";
  const [mdAssoc, setMdAssoc] = useState<MdAssocStatus | "loading">("loading");
  const [mdAssocBusy, setMdAssocBusy] = useState(false);

  const refreshMdAssoc = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const s = await invoke<string>("get_md_association_status");
      if (s === "default" || s === "registered" || s === "unregistered") setMdAssoc(s);
    } catch {
      /* 查询失败保持当前状态 */
    }
  }, []);

  useEffect(() => { void refreshMdAssoc(); }, [refreshMdAssoc]);
  // 用户去系统设置确认后返回，窗口重新获焦时自动刷新状态
  useEffect(() => {
    const onFocus = () => void refreshMdAssoc();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshMdAssoc]);

  const handleMdAssocToggle = async (enable: boolean) => {
    if (mdAssocBusy) return;
    setMdAssocBusy(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_md_association", { enable });
      toast(enable ? "已注册 .md 打开方式，请在设置页中点击 .md 一行并选择 PastePanda" : "已取消 .md 文件关联", "success");
      await refreshMdAssoc();
    } catch (e) {
      logger.warn("设置 .md 关联失败", e);
      toast(".md 文件关联设置失败", "error");
    } finally {
      setMdAssocBusy(false);
    }
  };

  // U52: 设置项搜索过滤
  const [settingsFilter, setSettingsFilter] = useState("");
  const settingsContainerRef = useRef<HTMLDivElement>(null);
  const noResultRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const container = settingsContainerRef.current;
    if (!container) return;
    const kw = settingsFilter.trim().toLowerCase();
    const children = Array.from(container.children) as HTMLElement[];
    // 第一遍：按文本匹配显示/隐藏每个设置行（分区标题留到第二遍）
    let visibleCount = 0;
    for (const el of children) {
      if (el.classList.contains(styles.sSection)) continue;
      const match = !kw || (el.textContent || "").toLowerCase().includes(kw);
      el.style.display = match ? "" : "none";
      if (match) visibleCount++;
    }
    // 第二遍：若某分区下已无可见行，则连分区标题一起隐藏
    let currentSection: HTMLElement | null = null;
    let sectionHasVisible = false;
    const flush = () => {
      if (currentSection) currentSection.style.display = sectionHasVisible ? "" : "none";
    };
    for (const el of children) {
      if (el.classList.contains(styles.sSection)) {
        flush();
        currentSection = el;
        sectionHasVisible = false;
      } else if (el.style.display !== "none") {
        sectionHasVisible = true;
      }
    }
    flush();
    if (noResultRef.current) {
      noResultRef.current.style.display = kw && visibleCount === 0 ? "" : "none";
    }
  }, [settingsFilter, config.lan_sync_enabled]);

  return (
    <>
      {/* U52: 设置搜索框（吸顶） */}
      <div className={styles.settingsSearch}>
        <span className={styles.settingsSearchIcon}>🔍</span>
        <input
          className={styles.settingsSearchInput}
          type="text"
          value={settingsFilter}
          placeholder="搜索设置项…"
          onChange={(e) => setSettingsFilter(e.target.value)}
        />
        {settingsFilter && (
          <button className={styles.settingsSearchClear} onClick={() => setSettingsFilter("")} title="清空搜索">✕</button>
        )}
      </div>
      <div ref={settingsContainerRef} className={styles.settingsSections}>
      {/* ── 数据统计 ── */}
      <div className={styles.sSection}>数据统计</div>
      <div className={styles.statsPanel}>
        <div className={styles.statsPanelHeader}>
          📊 剪贴板数据概览
          {loadedAt && <span className={styles.statsHeaderRight}>更新于 {loadedAt}</span>}
        </div>
        {stats && dash ? (
          <>
            {/* 核心指标 4 格 */}
            <div className={styles.bGrid4}>
              <div className={styles.bCell}>
                <div className={styles.bCellNum}>{stats.total.toLocaleString()}</div>
                <div className={styles.bCellLabel}>总记录</div>
              </div>
              <div className={styles.bCell}>
                <div className={`${styles.bCellNum} ${styles.cGreen}`}>{stats.pinned.toLocaleString()}</div>
                <div className={styles.bCellLabel}>⭐ 收藏</div>
              </div>
              <div className={styles.bCell}>
                <div className={`${styles.bCellNum} ${styles.cAccent}`}>{stats.today.toLocaleString()}</div>
                <div className={styles.bCellLabel}>今日新增</div>
                <div className={styles.bCellDelta}>
                  {dash.delta && (
                    <span className={`${styles.delta} ${dash.delta.up ? styles.deltaUp : styles.deltaDown}`}>{dash.delta.text}</span>
                  )}
                </div>
              </div>
              <div className={styles.bCell}>
                <div className={`${styles.bCellNum} ${styles.cOrange}`}>{stats.yesterday.toLocaleString()}</div>
                <div className={styles.bCellLabel}>昨日</div>
                <div className={styles.bCellDelta}>
                  <span className={styles.bCellAvg}>7日均 {dash.weekAvg}</span>
                </div>
              </div>
            </div>

            {/* 近 7 天趋势 */}
            <div className={styles.subTitle}>
              近 7 天趋势
              <span className={styles.subHint}>共 {dash.weekTotal.toLocaleString()} 条 · 悬停查看</span>
            </div>
            <div className={styles.bChartWrap}>
              <div className={styles.bChart}>
                <div className={styles.bGridLine} style={{ top: "22%" }} />
                <div className={styles.bGridLine} style={{ top: "55%" }} />
                <div className={styles.bGridLine} style={{ top: "88%" }} />
                <div className={styles.bBars}>
                  {stats.daily.map((d, i) => {
                    const isToday = i === stats.daily.length - 1;
                    const [, mm, dd] = d.date.split("-");
                    return (
                      <div key={d.date} className={`${styles.bDay} ${isToday ? styles.bDayToday : ""}`}>
                        <span className={styles.bDayVal}>{d.count}</span>
                        <i className={styles.bDayBar} style={{ height: `${Math.max(4, Math.round((d.count / dash.dailyMax) * 100))}%` }} />
                        <span className={styles.bDayLbl}>{isToday ? "今天" : `${Number(mm)}/${Number(dd)}`}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* 时段分布 + 类型占比 */}
            <div className={styles.bTwoCol}>
              <div className={styles.bCard}>
                <div className={styles.bCardTitle}>
                  时段分布
                  {dash.peakHour >= 0 && <span className={styles.bCardHint}>{dash.peakHour} 点峰值</span>}
                </div>
                <div className={styles.bHourBars}>
                  {stats.hours.map((v, i) => (
                    <i
                      key={i}
                      title={`${i} 时 · ${v} 条`}
                      className={dash.hourMax > 0 && v === dash.hourMax ? styles.bHourPeak : undefined}
                      style={{ height: `${Math.max(4, dash.hourMax > 0 ? Math.round((v / dash.hourMax) * 100) : 4)}%` }}
                    />
                  ))}
                </div>
                <div className={styles.bHourLbl}>
                  <span>0</span><span>6</span><span>12</span><span>18</span><span>24</span>
                </div>
              </div>
              <div className={styles.bCard}>
                <div className={styles.bCardTitle}>类型占比</div>
                <div className={styles.bDonutRow}>
                  <svg width="62" height="62" viewBox="0 0 76 76">
                    <g transform="rotate(-90 38 38)">
                      <circle cx="38" cy="38" r="30" fill="none" stroke="var(--input-bg)" strokeWidth="10" />
                      <circle cx="38" cy="38" r="30" fill="none" stroke="var(--accent)" strokeWidth="10"
                        strokeDasharray={`${dash.textArc} ${dash.C - dash.textArc}`} strokeDashoffset="0" />
                      <circle cx="38" cy="38" r="30" fill="none" stroke="var(--teal, #2DD4BF)" strokeWidth="10"
                        strokeDasharray={`${dash.imageArc} ${dash.C - dash.imageArc}`} strokeDashoffset={-dash.textArc} />
                      <circle cx="38" cy="38" r="30" fill="none" stroke="var(--orange)" strokeWidth="10"
                        strokeDasharray={`${dash.fileArc} ${dash.C - dash.fileArc}`} strokeDashoffset={-(dash.textArc + dash.imageArc)} />
                    </g>
                    <text x="38" y="42" textAnchor="middle" fontSize="12" fontWeight="700" fill="var(--text-primary)">{dash.textPct}%</text>
                  </svg>
                  <div className={styles.bDonutLegend}>
                    <div className={styles.bLegItem}><i className={styles.bLegDot} style={{ background: "var(--accent)" }} />文本<b>{stats.text_count.toLocaleString()}</b></div>
                    <div className={styles.bLegItem}><i className={styles.bLegDot} style={{ background: "var(--teal, #2DD4BF)" }} />图片<b>{stats.image_count.toLocaleString()}</b></div>
                    <div className={styles.bLegItem}><i className={styles.bLegDot} style={{ background: "var(--orange)" }} />文件<b>{stats.file_count.toLocaleString()}</b></div>
                  </div>
                </div>
              </div>
            </div>

            {/* 来源 Top 5（默认折叠） */}
            {stats.sources.length > 0 && (
              <>
                <button
                  type="button"
                  className={`${styles.srcHead} ${srcOpen ? styles.srcHeadOpen : ""}`}
                  onClick={() => setSrcOpen((v) => !v)}
                >
                  <span className={styles.srcChev}>
                    <svg width="10" height="10" viewBox="0 0 10 10">
                      <path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                  <span className={styles.srcTitle}>来源 Top 5</span>
                  <span className={styles.srcHint}>按复制次数</span>
                  {dash.srcSummary && <span className={styles.srcSummary}>{dash.srcSummary}</span>}
                </button>
                <div className={`${styles.srcBody} ${srcOpen ? styles.srcBodyOpen : ""}`}>
                  {stats.sources.map((s, i) => {
                    const meta = resolveSource(s.source);
                    return (
                      <div className={styles.bSrcRow} key={s.source}>
                        <span className={`${styles.bSrcRank} ${i < 3 ? styles.bSrcRankTop : ""}`}>{i + 1}</span>
                        <SourceRowIcon source={s.source} sourceIcon={s.source_icon} fallbackEmoji={meta.icon} color={meta.color} />
                        <span className={styles.bSrcName}>{meta.displayName || s.source}</span>
                        <span className={styles.bSrcTrack}>
                          <span className={styles.bSrcFill} style={{ width: `${Math.max(4, Math.round((s.count / dash.srcMax) * 100))}%` }} />
                        </span>
                        <span className={styles.bSrcCnt}>{s.count.toLocaleString()}</span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            <div className={styles.statsPanelFooter}>
              <span>💾 {stats.db_size_kb.toFixed(1)} KB</span>
              {stats.earliest_time && <span>📅 最早 {stats.earliest_time.split(" ")[0]}</span>}
              <span>📦 {config.current_workspace || "默认"}空间</span>
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
                onClick={() => {
                  updateAndSave({ theme: t.key });
                  applyTheme(t.key as ThemeKey);
                  // 广播到所有独立窗口（快捷粘贴/托盘弹窗/编辑器），使其切主题实时跟随。
                  // emit 广播是幂等的：主窗口自身也会收到，但 applyTheme 重复执行无副作用。
                  emit("theme-changed", { theme: t.key }).catch(() => { /* 广播失败不影响本窗口已生效 */ });
                }}
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
              tooltip="启动后每小时自动清理超过指定天数、未置顶的记录"
              detailTitle="自动清理"
              detail={<>
                <p>应用启动后每小时检查一次，自动删除超过指定天数的旧记录。</p>
                <p>📌 <b>推荐 30 天</b>：平衡存储空间和历史追溯</p>
                <p>📌 置顶记录永不清理；手动「清理过期记录」同样受此天数约束</p>
                <p>⚠️ 设为「关」则不自动清理，需手动管理</p>
              </>}
            />
          </div>
          <div className={`${styles.sRowDesc}`}>清理超过该天数的记录（置顶除外），启动后每小时自动执行</div>
        </div>
        <div className={styles.sCleanup}>
          {CLEANUP_OPTIONS.map((opt, idx) => (
            <button key={`cleanup-${opt.value ?? idx}`}
              className={`${styles.sCleanupOpt}${cleanupDays === opt.value ? ` ${styles.active}` : ""}`}
              onClick={() => { void handlePickCleanupDays(opt.value); }}>
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
      <ToggleRow icon="🛡" gradient="linear-gradient(135deg, #EF4444, #DC2626)" label="敏感内容防护" desc="不记录匹配密钥/凭证模式的内容" value={config.skip_sensitive} onChange={(v) => updateAndSave({ skip_sensitive: v })}
        tooltip="开启后，复制密码、Token、密钥等敏感内容时不会记录到历史，也不会通过局域网同步"
        detailTitle="敏感内容防护"
        detail={<>
          <p>开启后，剪贴板捕获到匹配密钥/凭证特征的内容（如 JWT、AWS Key、GitHub Token、长 Base64 串）时，将<b>不写入历史、不显示、不局域网同步</b>。</p>
          <p>📌 <b>适合场景</b>：从密码管理器或网页复制密码、复制 API 密钥</p>
          <p>💡 建议保持开启，避免敏感信息意外留存</p>
        </>}
      />
      <div className={styles.sRow}>
        <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #F43F5E, #E11D48)" }}>🚫</span>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>
            应用排除名单
            <HelpTooltip tooltip="来自这些应用的复制内容不会被记录，多个应用用英文逗号分隔" />
          </div>
          <div className={`${styles.sRowDesc}`}>来自这些应用的复制内容不会被记录（逗号分隔）</div>
          <input
            type="text"
            value={config.excluded_apps}
            placeholder="例如：KeePass, 1Password, Bitwarden"
            onChange={(e) => updateAndSave({ excluded_apps: e.target.value })}
            style={{
              marginTop: 6,
              width: "100%",
              padding: "6px 10px",
              fontSize: 12,
              borderRadius: 8,
              border: "1px solid var(--border-color)",
              background: "var(--input-bg)",
              color: "var(--text-primary)",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
        </div>
      </div>
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
      <ToggleRow icon="✨" gradient="linear-gradient(135deg, #0EA5E9, #8B5CF6)" label="窗口动画" desc="弹框与全屏窗口打开/关闭时的过渡动画" value={config.window_animation}
        tooltip="玻璃浮升效果；关闭后弹框与全屏编辑器即时显隐"
        detailTitle="窗口动画"
        detail={<>
          <p>控制弹框与全屏编辑器打开/关闭时的过渡动画（玻璃浮升效果）。</p>
          <p>📌 <b>开启</b>：弹框浮升进入、背景模糊渐显，关闭时平滑退场</p>
          <p>📌 <b>关闭</b>：即时显示/隐藏，无任何过渡</p>
          <p>💡 默认开启；追求极速响应可关闭</p>
        </>}
        onChange={(v) => updateAndSave({ window_animation: v })} />
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
      <ToggleRow icon="📝" gradient="linear-gradient(135deg, #6366F1, #8B5CF6)" label="编辑器保存写入历史" desc="全屏编辑器中保存 .md 文件时，同时写入剪贴板历史" value={config.md_save_to_history} onChange={(v) => updateAndSave({ md_save_to_history: v })}
        tooltip="开启后，在全屏 Markdown 编辑器中编辑并保存 .md 文件时，内容会同时作为一条剪贴板记录保存"
        detailTitle="编辑器保存写入历史"
        detail={<>
          <p>在全屏 Markdown 编辑器中编辑 .md 文件并保存时，是否同时将内容写入剪贴板历史。</p>
          <p>📌 <b>开启</b>：保存文件后，内容也会出现在剪贴板历史中，方便后续粘贴</p>
          <p>📌 <b>关闭</b>：仅保存文件，不写入历史</p>
          <p>💡 默认开启，适合编辑后需要频繁粘贴的场景</p>
        </>}
      />
      <ToggleRow icon="💾" gradient="linear-gradient(135deg, #10B981, #059669)" label="编辑器自动保存" desc="全屏编辑器中停止输入后自动回写内容" value={config.md_auto_save} onChange={(v) => updateAndSave({ md_auto_save: v })}
        tooltip="开启后，在全屏 Markdown 编辑器中输入停顿约 1 秒后，内容自动保存（卡片回写数据库 / 文件写回磁盘），无需手动按 Ctrl+S"
        detailTitle="编辑器自动保存"
        detail={<>
          <p>在全屏 Markdown 编辑器中编辑时，停止输入约 1 秒后自动保存内容。</p>
          <p>📌 <b>来自卡片</b>：自动回写到对应的剪贴板记录</p>
          <p>📌 <b>来自文件</b>：自动写回磁盘（不会重复写入剪贴板历史）</p>
          <p>📌 <b>新建未保存的文档</b>：没有保存目标，不会自动保存，需手动另存为</p>
          <p>💡 默认开启，防止意外丢失编辑内容</p>
        </>}
      />
      {/* .md 文件关联：状态实时取自注册表，三态显示 */}
      <div className={styles.sRow}>
        <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #0EA5E9, #0284C7)" }}>📎</span>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>
            关联 .md 文件
            <HelpTooltip
              tooltip="注册 .md 打开方式并引导设为默认，双击 .md 直接用全屏编辑器打开"
              detailTitle="关联 .md 文件"
              detail={<>
                <p>将 PastePanda 注册为 .md 文件的打开方式，并引导你在系统设置中确认为默认程序。</p>
                <p>📌 <b>生效后</b>：双击任意 .md 文件，直接用 PastePanda 全屏编辑器打开</p>
                <p>📌 开启后会打开系统「默认应用」设置页并定位到 PastePanda，点击 .md 一行选择 PastePanda 即可</p>
                <p>⚠️ Windows 不允许应用静默设为默认，需手动确认一次</p>
              </>}
            />
          </div>
          <div className={`${styles.sRowDesc}`}>
            {mdAssoc === "default" ? "已是 .md 默认打开方式 ✓"
              : mdAssoc === "registered" ? "已注册打开方式，尚未设为默认"
              : mdAssoc === "loading" ? "检测中…"
              : "双击 .md 文件直接用 PastePanda 编辑"}
          </div>
        </div>
        {mdAssoc === "registered" && (
          <button className={styles.sAction} disabled={mdAssocBusy} onClick={() => void handleMdAssocToggle(true)}>
            设为默认
          </button>
        )}
        <button
          className={`${styles.sToggle} ${mdAssoc !== "unregistered" && mdAssoc !== "loading" ? styles.on : styles.off}`}
          disabled={mdAssocBusy || mdAssoc === "loading"}
          onClick={() => void handleMdAssocToggle(mdAssoc === "unregistered" || mdAssoc === "loading")}>
          <span className={styles.sToggleThumb} />
          <span className={styles.sToggleLabel}>{mdAssoc !== "unregistered" && mdAssoc !== "loading" ? "开" : "关"}</span>
        </button>
      </div>

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
        <HotkeyRecorder value={config.hotkey} allowClear taken={[config.sequential_hotkey ?? "", config.stack_toggle_hotkey ?? "", config.stack_paste_hotkey ?? "", config.quick_paste_hotkey ?? ""]} onChange={async (v) => {
          const oldVal = config.hotkey;
          await updateAndSave({ hotkey: v });
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("reregister_hotkeys");
            toast("快捷键已更新", "success");
          } catch (e) {
            await updateAndSave({ hotkey: oldVal });
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn("热键设置失败", e);
            toast(`快捷键设置失败：${msg}。变更未生效，已恢复原值`, "error");
          }
        }} />
      </div>
      <div className={styles.sRow}>
        <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #8B5CF6, #5856D6)" }}>📋</span>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>依次粘贴</div>
          <div className={`${styles.sRowDesc}`}>按顺序逐条粘贴剪贴板</div>
        </div>
        <HotkeyRecorder value={config.sequential_hotkey ?? ""} allowClear taken={[config.hotkey, config.stack_toggle_hotkey ?? "", config.stack_paste_hotkey ?? "", config.quick_paste_hotkey ?? ""]} onChange={async (v) => {
          const oldVal = config.sequential_hotkey ?? "";
          await updateAndSave({ sequential_hotkey: v });
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("reregister_hotkeys");
            toast("快捷键已更新", "success");
          } catch (e) {
            await updateAndSave({ sequential_hotkey: oldVal });
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn("热键设置失败", e);
            toast(`快捷键设置失败：${msg}。变更未生效，已恢复原值`, "error");
          }
        }} />
      </div>
      <div className={styles.sRow}>
        <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #F97316, #EA580C)" }}>📚</span>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>收集模式开关</div>
          <div className={`${styles.sRowDesc}`}>进入/退出剪贴板收集模式（栈模式）</div>
        </div>
        <HotkeyRecorder value={config.stack_toggle_hotkey ?? ""} allowClear taken={[config.hotkey, config.sequential_hotkey ?? "", config.stack_paste_hotkey ?? "", config.quick_paste_hotkey ?? ""]} onChange={async (v) => {
          const oldVal = config.stack_toggle_hotkey ?? "";
          await updateAndSave({ stack_toggle_hotkey: v });
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("reregister_hotkeys");
            toast("快捷键已更新", "success");
          } catch (e) {
            await updateAndSave({ stack_toggle_hotkey: oldVal });
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn("热键设置失败", e);
            toast(`快捷键设置失败：${msg}。变更未生效，已恢复原值`, "error");
          }
        }} />
      </div>
      <div className={styles.sRow}>
        <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #FB923C, #F97316)" }}>📤</span>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>粘贴最近收集</div>
          <div className={`${styles.sRowDesc}`}>粘贴最近收集的内容并移出收集列表</div>
        </div>
        <HotkeyRecorder value={config.stack_paste_hotkey ?? ""} allowClear taken={[config.hotkey, config.sequential_hotkey ?? "", config.stack_toggle_hotkey ?? "", config.quick_paste_hotkey ?? ""]} onChange={async (v) => {
          const oldVal = config.stack_paste_hotkey ?? "";
          await updateAndSave({ stack_paste_hotkey: v });
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("reregister_hotkeys");
            toast("快捷键已更新", "success");
          } catch (e) {
            await updateAndSave({ stack_paste_hotkey: oldVal });
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn("热键设置失败", e);
            toast(`快捷键设置失败：${msg}。变更未生效，已恢复原值`, "error");
          }
        }} />
      </div>
      <div className={styles.sRow}>
        <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #14B8A6, #0D9488)" }}>⚡</span>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>快捷粘贴</div>
          <div className={`${styles.sRowDesc}`}>在光标处弹出面板，快速选择并粘贴（类 Win+V）</div>
        </div>
        <HotkeyRecorder value={config.quick_paste_hotkey ?? ""} allowClear taken={[config.hotkey, config.sequential_hotkey ?? "", config.stack_toggle_hotkey ?? "", config.stack_paste_hotkey ?? ""]} onChange={async (v) => {
          const oldVal = config.quick_paste_hotkey ?? "";
          await updateAndSave({ quick_paste_hotkey: v });
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("reregister_hotkeys");
            toast("快捷键已更新", "success");
          } catch (e) {
            await updateAndSave({ quick_paste_hotkey: oldVal });
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn("热键设置失败", e);
            toast(`快捷键设置失败：${msg}。变更未生效，已恢复原值`, "error");
          }
        }} />
      </div>
      <div className={styles.sRow}>
        <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #0EA5E9, #0284C7)" }}>🗂️</span>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>面板布局</div>
          <div className={`${styles.sRowDesc}`}>
            {config.quick_paste_layout === "list" ? "单栏列表，贴近原生 Win+V，同屏可览更多条" : "双栏网格，卡片预览更多内容"}
          </div>
        </div>
        <div className={styles.sSegGroup}>
          <button className={`${styles.sSegOpt}${config.quick_paste_layout === "grid" ? ` ${styles.sSegActive}` : ""}`} onClick={() => updateAndSave({ quick_paste_layout: "grid" })} title="双栏网格">
            <span className={styles.sSegEmoji}>🔲</span>
          </button>
          <button className={`${styles.sSegOpt}${config.quick_paste_layout === "list" ? ` ${styles.sSegActive}` : ""}`} onClick={() => updateAndSave({ quick_paste_layout: "list" })} title="单栏列表">
            <span className={styles.sSegEmoji}>☰</span>
          </button>
        </div>
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
      <div className={styles.sRow}>
        <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #EF4444, #F97316)" }}>🎯</span>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>
            深度清理
            <HelpTooltip
              tooltip="按时间范围 / 类型 / 来源应用自由组合条件，实时计数，可先预览再删除"
              detailTitle="深度清理"
              detail={<>
                <p>按组合条件精细化清理记录，适合释放空间或清除某个应用的全部记录。</p>
                <p>📌 <b>时间范围</b>：全部 / 超过 7·30·90 天</p>
                <p>📌 <b>类型</b>：全部 / 文本 / 图片 / 文件</p>
                <p>📌 <b>来源应用</b>：只清理来自指定应用的记录</p>
                <p>💡 实时统计匹配条数，可展开预览；置顶记录自动跳过，删除后可 Ctrl+Z 撤销</p>
              </>}
            />
          </div>
          <div className={`${styles.sRowDesc}`}>按时间 / 类型 / 来源组合条件清理，支持预览与撤销</div>
        </div>
        <button className={styles.sAction} onClick={() => setShowDeepClean(true)}>打开</button>
      </div>
      </div>
      <div ref={noResultRef} className={styles.settingsNoResult} style={{ display: "none" }}>
        😕 没有找到与「{settingsFilter}」匹配的设置项
      </div>
      {/* 深度清理弹窗：portal 到 body，open 门控显隐 */}
      <DeepCleanDialog open={showDeepClean} onClose={() => setShowDeepClean(false)} />
      {/* 修复：改保留天数变严格时的二次确认（自动清理不可撤销，必须让用户先知道会删多少条） */}
      <ConfirmDialog key="cleanup-days-confirm"
        open={!!pendingCleanup}
        title="确认缩短保留天数"
        message={pendingCleanup
          ? (pendingCleanup.count === null
              ? `改为保留 ${pendingCleanup.days} 天后，超期的未置顶记录将在下次自动清理时被删除且无法撤销（本次未能统计出具体条数）。确认？`
              : `改为保留 ${pendingCleanup.days} 天后，将有 ${pendingCleanup.count} 条超期记录（置顶除外）在下次自动清理时被删除，且无法撤销。确认？`)
          : ""}
        confirmText="确认修改"
        variant="danger"
        onConfirm={() => {
          const days = pendingCleanup?.days;
          setPendingCleanup(null);
          if (days !== undefined) void updateAndSave({ auto_cleanup_days: days });
        }}
        onCancel={() => setPendingCleanup(null)}
      />
    </>
  );
}
