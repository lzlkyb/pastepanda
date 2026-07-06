import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAppStore, FilterType, TimeFilter, SourceFilter } from "@/stores/appStore";
import { getAppVersion, getAppName, fetchCounts } from "@/lib/api";
import { cleanSourceName, getSourceIcon } from "@/lib/utils";
import { UpdateBadge } from "@/components/UpdateBadge";
import { AppIcon } from "@/components/AppIcon";
import { SearchBox } from "@/components/SearchBox";
import { logger } from "@/lib/logger";
import { ChevronDown } from "lucide-react";
import styles from "./TopBar.module.css";

const TABS: { key: FilterType; label: string; icon: string }[] = [
  { key: "all",    label: "全部", icon: "📋" },
  { key: "text",   label: "文本", icon: "📝" },
  { key: "image",  label: "图片", icon: "📸" },
  { key: "file",   label: "文件", icon: "📁" },
  { key: "pinned", label: "收藏", icon: "⭐" },
];

const TIME_OPTIONS: { key: TimeFilter; label: string }[] = [
  { key: "all",   label: "全部时间" },
  { key: "today", label: "今天" },
  { key: "week",  label: "本周" },
  { key: "month", label: "本月" },
];

async function minimizeWin() {
  try { (await import("@tauri-apps/api/window")).getCurrentWindow().minimize(); } catch { logger.warn("窗口最小化失败"); }
}
async function hideWin() {
  try { (await import("@tauri-apps/api/window")).getCurrentWindow().hide(); } catch { logger.warn("窗口隐藏失败"); }
  // 首次隐藏时提示托盘退出方式
  const KEY = "pasteship_hidden_tip_shown";
  try {
    if (!localStorage.getItem(KEY)) {
      localStorage.setItem(KEY, "1");
      window.dispatchEvent(new CustomEvent("first-time-tip", { detail: { id: "hide_window", message: "窗口已隐藏到托盘，右键托盘图标可退出或重新打开", type: "info" } }));
    }
  } catch { /* ignore */ }
}

type TabStyle = "segmented" | "circle";

function getTabStyle(): TabStyle {
  try { return (localStorage.getItem("tabStyle") as TabStyle) || "segmented"; } catch { return "segmented"; }
}
function saveTabStyle(v: TabStyle) {
  try { localStorage.setItem("tabStyle", v); } catch { logger.warn("保存tab样式失败"); }
}

export function TopBar({ onSettings, onSnippets, onExtract, onToggleSidebar, sidebarOpen }: {
  onSettings?: () => void; onSnippets?: () => void; onExtract?: () => void;
  onToggleSidebar?: () => void; sidebarOpen?: boolean;
}) {
  const filterType = useAppStore((s) => s.filterType);
  const setFilterType = useAppStore((s) => s.setFilterType);
  const timeFilter = useAppStore((s) => s.timeFilter);
  const setTimeFilter = useAppStore((s) => s.setTimeFilter);
  const sourceFilter = useAppStore((s) => s.sourceFilter);
  const setSourceFilter = useAppStore((s) => s.setSourceFilter);
  const ws = useAppStore((s) => s.config.current_workspace);
  const [tabStyle, setTabStyle] = useState<TabStyle>(getTabStyle);
  const [appVersion, setAppVersion] = useState("...");
  const [appName, setAppName] = useState("PastePanda");
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [countsError, setCountsError] = useState(false);

  useEffect(() => {
    getAppVersion().then(setAppVersion).catch(() => setAppVersion("?.?.?"));
    getAppName().then((name) => {
      setAppName(name);
      document.title = name;
    }).catch(() => setAppName("PastePanda"));
  }, []);

  // 从后端获取计数（带 30s 缓存）
  const refreshCounts = useCallback(() => {
    let cancelled = false;
    fetchCounts(ws).then(c => {
      if (!cancelled) { setCounts(c); setCountsError(false); }
    }).catch(() => {
      if (!cancelled) setCountsError(true);
    });
    return () => { cancelled = true; };
  }, [ws]);

  useEffect(() => {
    const cleanup = refreshCounts();
    return cleanup;
  }, [refreshCounts]);

  // 监听缓存失效事件，实时刷新计数
  useEffect(() => {
    const handler = () => refreshCounts();
    window.addEventListener("counts-invalidated", handler);
    return () => window.removeEventListener("counts-invalidated", handler);
  }, [refreshCounts]);

  // 监听 localStorage 变化（SettingsDialog 更新 tabStyle 时触发）
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === "tabStyle" && e.newValue) {
        setTabStyle(e.newValue as TabStyle);
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  return (
    <div className={styles.header} data-tauri-drag-region role="banner">
      {/* 标题行 */}
      <div className={styles.headerTop} data-tauri-drag-region>
        <div className={styles.headerTitle}>
          <button
            className={`${styles.sidebarToggle}${sidebarOpen ? ` ${styles.sidebarToggleActive}` : ""}`}
            onClick={onToggleSidebar}
            title={sidebarOpen ? "收起侧边栏" : "展开侧边栏"}
            aria-label="切换侧边栏"
          >
            ☰
          </button>
          <span className={styles.headerTitleIcon}><AppIcon size={20} /></span>
          <span className={styles.headerTitleText}>{appName}</span>
          <UpdateBadge currentVersion={appVersion} />
        </div>
        <div className={styles.headerIcons} data-tauri-drag-region="false">
          <IconBtn tip="片段库" onClick={onSnippets}><span className={styles.iconEmoji}>📝</span></IconBtn>
          <IconBtn tip="内容提取" onClick={onExtract}><span className={styles.iconEmoji}>🧲</span></IconBtn>
          <IconBtn tip="设置 · 帮助 · 关于" onClick={onSettings}>
            <svg className={styles.iconSvg} viewBox="0 0 24 24" fill="none" stroke="#60A5FA" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
          </IconBtn>
          <IconBtn tip="最小化到任务栏" onClick={minimizeWin}>
            <svg className={styles.iconSvg} viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2" strokeLinecap="round"><path d="M5 12h14"/></svg>
          </IconBtn>
          <IconBtn tip="隐藏窗口" onClick={hideWin}>
            <svg className={styles.iconSvg} viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </IconBtn>
        </div>
      </div>

      {/* 搜索框 + Tab 在同一个容器内，保证宽度完全一致 */}
      <div className={styles.headerControls}>
        <SearchBox />

        {/* Tab 区域 */}
        <div className={styles.tabsArea} data-tauri-drag-region="false">
          {countsError && (
            <div className={styles.countsErrorHint} title="统计数据加载失败">
              <span style={{ fontSize: 10, color: "var(--danger)", display: "flex", alignItems: "center", gap: 4, padding: "2px 0" }}>
                ⚠ 计数获取失败
              </span>
            </div>
          )}
          <AnimatePresence mode="wait">
            {tabStyle === "segmented" ? (
              <motion.div key="seg" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={{ duration: 0.15 }}>
                <SegmentedTabs filterType={filterType} setFilterType={setFilterType} counts={counts} />
              </motion.div>
            ) : (
              <motion.div key="circle" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={{ duration: 0.15 }}>
                <CircleTabs filterType={filterType} setFilterType={setFilterType} counts={counts} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* 时间 + 来源筛选行 */}
        <div className={styles.filterBar} data-tauri-drag-region="false">
          <FilterDropdown
            label="时间"
            value={timeFilter}
            options={TIME_OPTIONS}
            onChange={(v) => setTimeFilter(v as TimeFilter)}
          />
          <SourceFilterDropdown
            value={sourceFilter}
            onChange={setSourceFilter}
            workspace={ws}
          />
        </div>
      </div>
    </div>
  );
}

/* ===== 方案 B：iOS 分段控件 ===== */
function SegmentedTabs({ filterType, setFilterType, counts }: {
  filterType: FilterType; setFilterType: (f: FilterType) => void; counts: Record<string, number> | null;
}) {
  const getCount = (key: string) => (counts ? counts[key] : undefined);
  return (
    <div className={styles.segmented}>
      {TABS.map((tab) => {
        const active = filterType === tab.key;
        const count = getCount(tab.key);
        return (
          <button key={tab.key} onClick={() => setFilterType(tab.key)}
            className={`${styles.segItem}${active ? ` ${styles.segItemActive}` : ""}`}
            style={{ position: "relative" }}>
            {active && (
              <motion.div
                layoutId="seg-active"
                className={styles.segActiveIndicator}
                transition={{ type: "spring", stiffness: 400, damping: 30 }}
              />
            )}
            <span className={styles.segIcon}>{tab.icon}</span>
            <span>{tab.label}</span>
            {count !== undefined && count > 0 && <span className={`${styles.segCount}${active ? ` ${styles.segItemActive}` : ""}`}>{count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/* ===== 方案 C：圆形图标 Tab ===== */
function CircleTabs({ filterType, setFilterType, counts }: {
  filterType: FilterType; setFilterType: (f: FilterType) => void; counts: Record<string, number> | null;
}) {
  const getCount = (key: string) => (counts ? counts[key] : undefined);
  return (
    <div className={styles.tabsCircle}>
      {TABS.map((tab) => {
        const active = filterType === tab.key;
        const count = getCount(tab.key);
        return (
          <button key={tab.key} onClick={() => setFilterType(tab.key)}
            className={`${styles.circleTab}${active ? ` ${styles.circleTabActive}` : ""}`}>
            <div className={styles.circleIcon}>
              <span style={{ fontSize: 22 }}>{tab.icon}</span>
            </div>
            <span className={styles.circleLabel}>{tab.label}</span>
            {count !== undefined && count > 0 && <span className={styles.circleBadge}>{count}</span>}
          </button>
        );
      })}
    </div>
  );
}

function IconBtn({ children, tip, danger, onClick, ariaLabel }: {
  children: React.ReactNode; tip: string; danger?: boolean; onClick?: () => void; ariaLabel?: string;
}) {
  return (
    <button title={tip} aria-label={ariaLabel || tip} onClick={onClick}
      className={`${styles.iconBtn}${danger ? ` ${styles.iconBtnDanger}` : ""}`}>
      {children}
    </button>
  );
}

/* ===== 筛选下拉组件 ===== */
function FilterDropdown<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: { key: T; label: string }[]; onChange: (v: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const activeLabel = options.find((o) => o.key === value)?.label || label;

  return (
    <div className={styles.filterDropdown} ref={ref}>
      <button className={styles.filterDropdownBtn} onClick={() => setOpen(!open)}>
        <span>{activeLabel}</span>
        <ChevronDown size={12} style={{ transition: "transform 0.2s", transform: open ? "rotate(180deg)" : "rotate(0)" }} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.96 }}
            transition={{ type: "spring", stiffness: 500, damping: 35 }}
            className={styles.filterDropdownMenu}
          >
            {options.map((opt) => (
              <button key={opt.key}
                className={`${styles.filterDropdownItem}${opt.key === value ? ` ${styles.filterDropdownItemActive}` : ""}`}
                onClick={() => { onChange(opt.key); setOpen(false); }}>
                {opt.label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ===== 来源筛选下拉 ===== */
function SourceFilterDropdown({ value, onChange, workspace }: {
  value: SourceFilter; onChange: (v: SourceFilter) => void; workspace: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // 只订阅 history.length 作为缓存失效信号，避免每次 history 变化都重渲染
  const historyLen = useAppStore((s) => s.history.length);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // 收集当前工作空间下的所有来源应用（清洗名称 + 图标映射）
  // historyLen 作为缓存失效信号
  const sources = useMemo(() => {
    const history = useAppStore.getState().history;
    const map = new Map<string, { cleaned: string; icon?: string }>();
    history.filter((h) => h.workspace === workspace && h.source).forEach((h) => {
      if (!map.has(h.source)) {
        map.set(h.source, { cleaned: cleanSourceName(h.source), icon: getSourceIcon(h.source) });
      }
    });
    return Array.from(map.entries())
      .sort((a, b) => a[1].cleaned.localeCompare(b[1].cleaned, "zh"));
  }, [historyLen, workspace]);

  // 当前选中来源的显示名称
  const activeLabel = useMemo(() => {
    if (!value) return "来源应用";
    const cleaned = cleanSourceName(value);
    const icon = getSourceIcon(value);
    return icon ? `${icon} ${cleaned}` : cleaned;
  }, [value]);

  return (
    <div className={styles.filterDropdown} ref={ref}>
      <button className={styles.filterDropdownBtn} onClick={() => setOpen(!open)}>
        <span>{activeLabel}</span>
        <ChevronDown size={12} style={{ transition: "transform 0.2s", transform: open ? "rotate(180deg)" : "rotate(0)" }} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.96 }}
            transition={{ type: "spring", stiffness: 500, damping: 35 }}
            className={styles.filterDropdownMenu}
          >
            <button className={`${styles.filterDropdownItem}${!value ? ` ${styles.filterDropdownItemActive}` : ""}`}
              onClick={() => { onChange(""); setOpen(false); }}>
              全部来源
            </button>
            {sources.map(([raw, { cleaned, icon }]) => (
              <button key={raw}
                className={`${styles.filterDropdownItem}${raw === value ? ` ${styles.filterDropdownItemActive}` : ""}`}
                onClick={() => { onChange(raw); setOpen(false); }}>
                {icon ? `${icon} ${cleaned}` : cleaned}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
