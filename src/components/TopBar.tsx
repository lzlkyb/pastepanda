import { useState, useMemo, useEffect, useRef, useCallback, Fragment } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAppStore, FilterType, TimeFilter, SourceFilter } from "@/stores/appStore";
import { getAppVersion, getAppName, fetchCounts, toggleStackMode } from "@/lib/api";
import { cleanSourceName, getSourceIcon, fetchRealSourceIcon } from "@/lib/source-mappings";
import SourceBadge from "@/components/SourceBadge";
import { UpdateBadge } from "@/components/UpdateBadge";
import { TagBadge, AnimatedTagBadge } from "@/components/TagBadge";
import { AppIcon } from "@/components/AppIcon";
import { SearchBox } from "@/components/SearchBox";
import { logger } from "@/lib/logger";
import { ChevronDown, Tag, X, EyeOff } from "lucide-react";
import styles from "./TopBar.module.css";

const TABS: { key: FilterType; label: string; icon: string }[] = [
  { key: "all",    label: "全部", icon: "📋" },
  { key: "text",   label: "文本", icon: "📝" },
  // 「图片」同时包含纯图片与图文混排（两者都是带图内容）。
  // 图文不单独占一个标签页：480px 默认窗宽下 6 个标签已经拥挤，
  // 只看图文时用「图文」自动标签精确筛。
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

/** 工具箱分组面板（方案 A）：片段库 / 内容提取从顶栏独立按钮迁入此处；依次粘贴从主窗口常驻 FAB 迁入此处 */
type ToolKey = "sequential" | "snippets" | "extract" | "encoding" | "replace" | "diff";
const TOOLBOX_GROUPS: {
  label: string;
  items: { key: ToolKey; icon: string; name: string; desc: string; hue: string }[];
}[] = [
  {
    label: "内容",
    items: [
      { key: "sequential", icon: "📋", name: "依次粘贴", desc: "按顺序逐条粘贴文本 · Ctrl+Alt+Q", hue: "cyan" },
      { key: "snippets", icon: "📝", name: "片段库",   desc: "常用文本收藏，一键粘贴",             hue: "amber" },
      { key: "extract",  icon: "🧲", name: "内容提取", desc: "从记录中批量提取链接 / 邮箱 / 电话", hue: "rose" },
    ],
  },
  {
    label: "文本处理",
    items: [
      { key: "encoding", icon: "🔤", name: "编码转换", desc: "Base64 / URL / Unicode 编解码",   hue: "sky" },
      { key: "replace",  icon: "🔁", name: "批量替换", desc: "正则查找替换，支持多条规则",       hue: "violet" },
      { key: "diff",     icon: "📊", name: "配置对比", desc: "两份配置语义级差异高亮",           hue: "green" },
    ],
  },
];

async function minimizeWin() {
  try { (await import("@tauri-apps/api/window")).getCurrentWindow().minimize(); } catch { logger.warn("窗口最小化失败"); }
}
async function hideWin() {
  // U6：首次隐藏时先派发提示并延迟隐藏，确保提示真正被看到
  // （原实现先 hide() 再派发事件，toast 渲染在已隐藏窗口里永远不可见，却已标记"已展示"）
  const KEY = "pastepanda_hidden_tip_shown";
  let firstHide = false;
  try { firstHide = !localStorage.getItem(KEY); } catch { /* ignore */ }
  if (firstHide) {
    window.dispatchEvent(new CustomEvent("first-time-tip", { detail: { id: "hide_window", message: "窗口已隐藏到托盘，右键托盘图标可退出或重新打开", type: "info" } }));
    try { localStorage.setItem(KEY, "1"); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 2000)); // 留出阅读提示的时间
  }
  try { (await import("@tauri-apps/api/window")).getCurrentWindow().hide(); } catch { logger.warn("窗口隐藏失败"); }
}

type TabStyle = "segmented" | "circle";

function getTabStyle(): TabStyle {
  try { return (localStorage.getItem("tabStyle") as TabStyle) || "segmented"; } catch { return "segmented"; }
}

export function TopBar({ onSettings, onSequential, onSnippets, onExtract, onEncoding, onBatchReplace, onConfigDiff, onToggleSidebar, sidebarOpen }: {
  onSettings?: () => void; onSequential?: () => void; onSnippets?: () => void; onExtract?: () => void;
  onEncoding?: () => void; onBatchReplace?: () => void; onConfigDiff?: () => void;
  onToggleSidebar?: () => void; sidebarOpen?: boolean;
}) {
  const filterType = useAppStore((s) => s.filterType);
  const setFilterType = useAppStore((s) => s.setFilterType);
  const timeFilter = useAppStore((s) => s.timeFilter);
  const setTimeFilter = useAppStore((s) => s.setTimeFilter);
  const sourceFilter = useAppStore((s) => s.sourceFilter);
  const setSourceFilter = useAppStore((s) => s.setSourceFilter);
  const selectedTagIds = useAppStore((s) => s.selectedTagIds);
  const toggleTagFilter = useAppStore((s) => s.toggleTagFilter);
  const clearTagFilters = useAppStore((s) => s.clearTagFilters);
  const allTags = useAppStore((s) => s.tags);
  const ws = useAppStore((s) => s.config.current_workspace);
  const stackMode = useAppStore((s) => s.stackMode);
  const stackToggleHotkey = useAppStore((s) => s.config.stack_toggle_hotkey);
  const [tabStyle, setTabStyle] = useState<TabStyle>(getTabStyle);
  const [appVersion, setAppVersion] = useState("...");
  const [appName, setAppName] = useState("PastePanda");
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [countsError, setCountsError] = useState(false);
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const [toolboxOpen, setToolboxOpen] = useState(false);

  useEffect(() => {
    getAppVersion().then(setAppVersion).catch(() => setAppVersion("?.?.?"));
    getAppName().then((name) => {
      setAppName(name);
      document.title = name;
    }).catch(() => setAppName("PastePanda"));
  }, []);

  // 从后端获取计数（带 30s 缓存）
  // cancelRef 始终持有“最近一次” refreshCounts 调用的取消函数，
  // 保证任意时刻最多只有一个 fetchCounts 结果能够生效：
  // 每次发起新请求前先取消上一个仍在途的请求，避免旧请求晚回导致覆盖新结果的竞态。
  const cancelRef = useRef<(() => void) | null>(null);
  const refreshCounts = useCallback(() => {
    cancelRef.current?.();
    let cancelled = false;
    fetchCounts(ws).then(c => {
      if (!cancelled) { setCounts(c); setCountsError(false); }
    }).catch(() => {
      if (!cancelled) setCountsError(true);
    });
    const cancel = () => { cancelled = true; };
    cancelRef.current = cancel;
    return cancel;
  }, [ws]);

  useEffect(() => {
    refreshCounts();
    return () => { cancelRef.current?.(); };
  }, [refreshCounts]);

  // 监听缓存失效事件，实时刷新计数
  useEffect(() => {
    const handler = () => { refreshCounts(); };
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

  // 工具箱条目 → 回调映射（片段库 / 内容提取 / 依次粘贴迁入后与原有三项统一管理）
  const toolHandlers: Record<ToolKey, (() => void) | undefined> = {
    sequential: onSequential,
    snippets: onSnippets,
    extract: onExtract,
    encoding: onEncoding,
    replace: onBatchReplace,
    diff: onConfigDiff,
  };

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
          <IconBtn tip={`收集模式（栈模式）· ${stackToggleHotkey || "ctrl+alt+k"}${stackMode ? " · 已开启" : ""}`} active={stackMode} hue="amber" onClick={() => toggleStackMode()}>
            {/* 定制双色调图标（方案 B）：顶层实心 + 下层渐淡描边，currentColor 自动跟随主题与激活态 */}
            <svg className={styles.iconSvg} viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 2.6 2.9 7.66a.95.95 0 0 0 0 1.68L12 14.4l9.1-5.06a.95.95 0 0 0 0-1.68Z" fill="currentColor" fillOpacity=".88" />
              <path d="m3.2 12.4 8.8 4.9 8.8-4.9" stroke="currentColor" strokeOpacity=".5" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
              <path d="m3.2 16.9 8.8 4.9 8.8-4.9" stroke="currentColor" strokeOpacity=".26" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </IconBtn>
          {/* 工具箱下拉（方案 A 分组面板）：片段库 / 内容提取已从顶栏独立按钮迁入此处 */}
          <div className={styles.toolboxWrap}>
            <IconBtn tip="工具箱" active={toolboxOpen} hue="sky" onClick={() => setToolboxOpen((v) => !v)}>
              {/* 定制双色调图标（方案 B）：轻填充箱体 + 提手 + 实心中扣，箱体语义比扳手更贴「工具箱」 */}
              <svg className={styles.iconSvg} viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M9 7.6V6.1a2.6 2.6 0 0 1 2.6-2.6h.8A2.6 2.6 0 0 1 15 6.1v1.5" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
                <rect x="2.9" y="7.6" width="18.2" height="12.6" rx="2.7" fill="currentColor" fillOpacity=".22" stroke="currentColor" strokeWidth="2.1" />
                <path d="M2.9 12.4h18.2" stroke="currentColor" strokeOpacity=".55" strokeWidth="2.1" />
                <rect x="10.35" y="10.75" width="3.3" height="3.3" rx="1.15" fill="currentColor" />
              </svg>
            </IconBtn>
            {toolboxOpen && (
              <>
                <div className={styles.toolboxBackdrop} onClick={() => setToolboxOpen(false)} />
                <div className={styles.toolboxPanel} role="menu" aria-label="工具箱">
                  {TOOLBOX_GROUPS.map((group, gi) => (
                    <Fragment key={group.label}>
                      {gi > 0 && <div className={styles.tbDivider} aria-hidden="true" />}
                      <div className={styles.tbSection}>{group.label}</div>
                      {group.items.map((tool) => (
                        <button
                          key={tool.key}
                          className={styles.tbItem}
                          role="menuitem"
                          onClick={() => { setToolboxOpen(false); toolHandlers[tool.key]?.(); }}
                        >
                          <span className={styles.tbTile} data-hue={tool.hue} aria-hidden="true">{tool.icon}</span>
                          <span className={styles.tbText}>
                            <span className={styles.tbName}>{tool.name}</span>
                            <span className={styles.tbDesc}>{tool.desc}</span>
                          </span>
                        </button>
                      ))}
                    </Fragment>
                  ))}
                </div>
              </>
            )}
          </div>
          <IconBtn tip="设置 · 帮助 · 关于" hue="violet" onClick={onSettings}>
            <svg className={styles.iconSvg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
          </IconBtn>
          {/* 分隔线：功能按钮组（栈模式/工具箱/设置）与窗口控制组（最小化/隐藏）分开 */}
          <span className={styles.headerDivider} aria-hidden="true" />
          <IconBtn tip="最小化到任务栏" onClick={minimizeWin}>
            <svg className={styles.iconSvg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 12h14"/></svg>
          </IconBtn>
          <IconBtn tip="隐藏到托盘（保持后台运行）" onClick={hideWin}>
            <EyeOff className={styles.iconSvg} strokeWidth="2" />
          </IconBtn>
        </div>
      </div>

      {/* 搜索框 + Tab 在同一个容器内，保证宽度完全一致 */}
      <div className={styles.headerControls}>
        {/* 搜索 + 时间/来源筛选同行（方案 A：筛选并入搜索行，省一行垂直空间） */}
        <div className={styles.searchFilterRow}>
          <SearchBox fill />
          <FilterDropdown
            label="时间"
            value={timeFilter}
            options={TIME_OPTIONS}
            onChange={(v) => setTimeFilter(v as TimeFilter)}
            auto
          />
          <SourceFilterDropdown
            value={sourceFilter}
            onChange={setSourceFilter}
            workspace={ws}
            auto
          />
        </div>

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

        {/* 标签筛选栏 */}
        {allTags.length > 0 && (
          <div className={styles.tagFilterBar} data-tauri-drag-region="false">
            {/* #10 筛选芯片增删动画：勾选标签时芯片弹入，点 × 时弹出，兄弟芯片 layout 让位 */}
            <AnimatePresence initial={false}>
            {selectedTagIds.map((tid) => {
              const tag = allTags.find((t) => t.id === tid);
              if (!tag) return null;
              return (
                <AnimatedTagBadge
                  key={tid}
                  tag={tag}
                  variant="chip"
                  onRemove={(t) => toggleTagFilter(t.id)}
                />
              );
            })}
            </AnimatePresence>
            {selectedTagIds.length > 0 && (
              <button className={styles.tagFilterClear} onClick={clearTagFilters} title="清除所有标签筛选">
                清除
              </button>
            )}
            <button
              className={styles.tagFilterAdd}
              onClick={() => setTagPickerOpen(!tagPickerOpen)}
            >
              <Tag size={12} /> 标签筛选
            </button>
            <AnimatePresence>
              {tagPickerOpen && (
                <TagPickerPopover
                  tags={allTags}
                  selectedTagIds={selectedTagIds}
                  onToggle={toggleTagFilter}
                  onClose={() => setTagPickerOpen(false)}
                />
              )}
            </AnimatePresence>
          </div>
        )}
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

function IconBtn({ children, tip, danger, active, hue, onClick, ariaLabel }: {
  children: React.ReactNode; tip: string; danger?: boolean; active?: boolean;
  /** 功能键默认色相（配色方案 B）：CSS 属性选择器映射固定色，复用工具箱瓷砖调色板 */
  hue?: "amber" | "sky" | "violet";
  onClick?: () => void; ariaLabel?: string;
}) {
  return (
    <button title={tip} aria-label={ariaLabel || tip} onClick={onClick} aria-expanded={active} data-hue={hue}
      className={`${styles.iconBtn}${danger ? ` ${styles.iconBtnDanger}` : ""}${active ? ` ${styles.iconBtnActive}` : ""}`}>
      {children}
    </button>
  );
}

/* ===== 筛选下拉组件 ===== */
function FilterDropdown<T extends string>({ label, value, options, onChange, auto }: {
  label: string; value: T; options: { key: T; label: string }[]; onChange: (v: T) => void; auto?: boolean;
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
    <div className={`${styles.filterDropdown}${auto ? ` ${styles.filterDropdownAuto}` : ""}`} ref={ref}>
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
function SourceFilterDropdown({ value, onChange, workspace, auto }: {
  value: SourceFilter; onChange: (v: SourceFilter) => void; workspace: string; auto?: boolean;
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

  // 收集当前工作空间下的所有来源应用（含 source_icon 信息）
  // historyLen 作为缓存失效信号
  const sources = useMemo(() => {
    const history = useAppStore.getState().history;
    const map = new Map<string, string | null>(); // source → source_icon
    history.filter((h) => h.workspace === workspace && h.source).forEach((h) => {
      if (!map.has(h.source)) {
        map.set(h.source, h.source_icon ?? null);
      } else if (h.source_icon && !map.get(h.source)) {
        // 更新：之前没有 source_icon 的，现在有了
        map.set(h.source, h.source_icon);
      }
    });
    return Array.from(map.entries())
      .sort(([a], [b]) => cleanSourceName(a).localeCompare(cleanSourceName(b), "zh"));
  }, [historyLen, workspace]);

  // source → source_icon 的快速查找表
  const sourceIconMap = useMemo(() => {
    const map = new Map<string, string | null>();
    sources.forEach(([source, icon]) => map.set(source, icon));
    return map;
  }, [sources]);

  // 当前选中来源的 source_icon
  const selectedSourceIcon = value ? sourceIconMap.get(value) ?? null : null;

  // 当前选中来源的显示名称
  const sourceIconMode = useAppStore((s) => s.config.source_icon_mode);
  const activeCacheKey = selectedSourceIcon || value;
  const activeIconUrl = useAppStore((s) => s.realIconCache[activeCacheKey]);

  useEffect(() => {
    if (sourceIconMode === "app" && value) {
      fetchRealSourceIcon(value, selectedSourceIcon);
    }
  }, [value, sourceIconMode, selectedSourceIcon]);

  const activeLabel = useMemo(() => {
    if (!value) return "全部来源";
    const cleaned = cleanSourceName(value);
    // 真实图标模式：显示真实图标
    if (sourceIconMode === "app" && activeIconUrl) {
      return <><img src={activeIconUrl} alt="" className={styles.filterDropdownIcon} /> {cleaned}</>;
    }
    // emoji 模式
    const icon = getSourceIcon(value);
    return <>{icon && <span>{icon}</span>} {cleaned}</>;
  }, [value, sourceIconMode, activeIconUrl]);

  return (
    <div className={`${styles.filterDropdown}${auto ? ` ${styles.filterDropdownAuto}` : ""}`} ref={ref}>
      <button className={styles.filterDropdownBtn} onClick={() => setOpen(!open)}>
        {activeLabel}
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
            {sources.map(([raw, icon]) => (
              <button key={raw}
                className={`${styles.filterDropdownItem}${raw === value ? ` ${styles.filterDropdownItemActive}` : ""}`}
                onClick={() => { onChange(raw); setOpen(false); }}>
                <SourceBadge source={raw} sourceIcon={icon} variant="plain" />
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ===== 标签选择 Popover ===== */
function TagPickerPopover({ tags, selectedTagIds, onToggle, onClose }: {
  tags: import("@/stores/appStore").Tag[];
  selectedTagIds: string[];
  onToggle: (tagId: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  // 分组：自动标签 vs 手动标签
  const { autoTags, manualTags } = useMemo(() => {
    const auto = tags.filter(t => t.source === "auto").sort((a, b) => a.name.localeCompare(b.name, "zh"));
    const manual = tags.filter(t => t.source === "manual").sort((a, b) => a.name.localeCompare(b.name, "zh"));
    return { autoTags: auto, manualTags: manual };
  }, [tags]);

  const renderTag = (tag: import("@/stores/appStore").Tag) => (
    <TagBadge
      key={tag.id}
      tag={tag}
      variant="picker"
      active={selectedTagIds.includes(tag.id)}
      onClick={(t) => onToggle(t.id)}
    />
  );

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: -4, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.96 }}
      transition={{ type: "spring", stiffness: 500, damping: 35 }}
      className={styles.tagPickerPopover}
    >
      <div className={styles.tagPickerHeader}>
        <span>选择标签筛选</span>
        <button className={styles.tagPickerClose} onClick={onClose}><X size={12} /></button>
      </div>
      <div className={styles.tagPickerBody}>
        {tags.length === 0 ? (
          <div className={styles.tagPickerEmpty}>
            暂无标签，右键卡片 → 编辑标签 来创建
          </div>
        ) : (
          <>
            {autoTags.length > 0 && (
              <>
                <div className={styles.tagPickerSection}>🤖 智能标签</div>
                {autoTags.map(renderTag)}
                {manualTags.length > 0 && <div className={styles.tagPickerDivider} />}
              </>
            )}
            {manualTags.length > 0 && (
              <>
                <div className={styles.tagPickerSection}>🏷️ 我的标签</div>
                {manualTags.map(renderTag)}
              </>
            )}
          </>
        )}
      </div>
    </motion.div>
  );
}
