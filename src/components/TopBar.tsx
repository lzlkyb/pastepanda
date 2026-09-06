import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAppStore, FilterType, TimeFilter, SourceFilter } from "@/stores/appStore";
import { AiStatusCap } from "@/components/AiStatusCap";
import { AiStatusDot } from "@/components/AiStatusDot";
import { AiMark } from "@/components/ai/AiMark";
import { getAppName, fetchCounts, toggleStackMode } from "@/lib/api";
import { cleanSourceName } from "@/lib/source-mappings";
import { useSourceIcon } from "@/hooks/useSourceIcon";
import SourceBadge from "@/components/SourceBadge";
import { UpdateBadge } from "@/components/UpdateBadge";
import { ModeSwitcher } from "@/components/ModeSwitcher";
import { TagBadge, AnimatedTagBadge } from "@/components/TagBadge";
import { AppIcon } from "@/components/AppIcon";
import { SearchBox } from "@/components/SearchBox";
import { logger } from "@/lib/logger";
import { ChevronDown, Tag, X, EyeOff } from "lucide-react";
import styles from "./TopBar.module.css";
import { useClickOutside } from "@/hooks/useClickOutside";

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

/* 工具箱已整体离开顶栏：D15 把它从下拉面板改成了「工具」模式的主体区。
   条目数据在 `@/lib/toolbox`（一模一样搬过去的），渲染在 `ToolboxView`，
   回调由 App.tsx 直接传给它——所以顶栏不再需要 onSequential / onSnippets / … 那一排 props。 */

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

export function TopBar({ onSettings, settingsOpen = false }: {
  onSettings?: () => void;
  /**
   * 设置视图是否正占着内容区。为 true 时隐掉**模式切换器与搜索/页签行**：
   * 那两样都是「记录模式」的东西，在设置里既无指向又让人以为还在记录页。
   *
   * 🔴 顶栏外壳（图标/名称/最小化/隐藏）**不能**一并藏：主窗口是
   * `decorated: false` 的无边框窗，这一条兼着 data-tauri-drag-region 拖动区
   * 与仅有的两个窗口控制按钮，藏了就拖不动也最小化不了。
   */
  settingsOpen?: boolean;
}) {
  const appMode = useAppStore((s) => s.appMode);
  // 侧栏开合直接读 store，不走 props：按钮要反映的是**当前模式**那一份，
  // 父层传一个固定的就会变成「在知识模式下显示的是记录模式的状态」。
  const sidebarOpen = useAppStore((s) => (s.appMode === "tools" ? false : s.sidebarOpen[s.appMode]));
  const onToggleSidebar = useAppStore((s) => s.toggleSidebar);
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
  const [appName, setAppName] = useState("PastePanda");
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [countsError, setCountsError] = useState(false);
  const [tagPickerOpen, setTagPickerOpen] = useState(false);

  useEffect(() => {
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

  return (
    <div className={styles.header} data-tauri-drag-region role="banner">
      {/* 标题行 */}
      <div className={styles.headerTop} data-tauri-drag-region>
        <div className={styles.headerTitle}>
          {/* 侧栏开关的**唯一入口**：点它切当前模式的侧栏
              （记录 = 分组导航，知识 = 文件夹树）。

              ❗ 原注释写的是「侧栏只属于记录模式，在工具/知识下无意义」——
              那句话在知识模式长出文件夹树之后就不成立了，而当时的实际效果是：
              这里置灰并提示「没有侧边栏」，而侧边栏就在下面、只是开关在别处。

              工具模式确实没侧栏，仍然禁用而不隐藏（隐藏会让标题行左侧宽度跳一下）。 */}
          <button
            className={`${styles.sidebarToggle}${sidebarOpen ? ` ${styles.sidebarToggleActive}` : ""}`}
            onClick={onToggleSidebar}
            disabled={appMode === "tools" || settingsOpen}
            title={
              settingsOpen
                ? "设置页没有侧边栏"
                : appMode === "tools"
                ? "工具模式没有侧边栏"
                : appMode === "knowledge"
                  ? sidebarOpen
                    ? "收起文件夹"
                    : "展开文件夹"
                  : sidebarOpen
                    ? "收起侧边栏"
                    : "展开侧边栏"
            }
            aria-label="切换侧边栏"
          >
            ☰
          </button>
          <span className={styles.headerTitleIcon}><AppIcon size={20} /></span>
          {/* 名位复用（D15）：应用名与更新状态共用这一个位置。
              为何把名字作为 prop 交给 UpdateBadge 而不是并列两个节点：
              只有它知道当前更新状态，只有它能在同一个 AnimatePresence 里做淡入淡出；
              而名字的样式属于本文件的 CSS module，所以节点在这里拼。 */}
          <UpdateBadge
            nameSlot={
              <span className={styles.brandTitle}>
                <span className={styles.headerTitleText}>{appName}</span>
                {/* 品牌标识：这个产品是 AI 的。不可点、不随 AI 配置状态变化——
                    「配好了没」由右侧 AiStatusCap / AiStatusDot 承担，两者不重叠。
                    上标随名字一起让位，不能留在外面——否则下载态会渲染成 `v6.18.6ᴬᴵ`。 */}
                <AiMark shape="sup" text="AI" title="PastePanda 的能力由 AI 驱动" />
              </span>
            }
          />
          {/* 三模式切换器（D15）：站在应用名右侧，宽度正好是名位复用省下的那一块。
              设置打开时不渲染：那时内容区是设置，再摆一个「记录|工具|知识」会让人以为还在记录页 */}
          {!settingsOpen && <ModeSwitcher />}
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
          {/* 工具箱按钮已撤掉：它现在是「工具」模式，从标题行的模式切换器进（D15） */}
          {/* v6.4 主窗口 AI 感知（方案 A）：胶囊 —— 未配置=引流入口；已配置=不渲染（状态收进设置按钮绿点） */}
          <AiStatusCap />
          {/* 审查方案 1：设置按钮带 AI 状态绿点 —— 已就绪时右上角一个 6px 绿点（hover 看详情），
              不占额外空间，能力入口在快捷区 */}
          <span className={styles.settingsWrap}>
            <IconBtn tip="设置 · 帮助 · 关于" hue="violet" onClick={onSettings}>
              <svg className={styles.iconSvg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
            </IconBtn>
            <AiStatusDot />
          </span>
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
      {/* 搜索行与页签行只属于「记录」模式（D15）。
          工具模式：两行都不渲染——工具既不需要按内容类型筛，也没有可搜的东西；
          知识模式：A 阶段也不渲染。设计稿原本写「搜索行换文案」，但 notes 表还没建，
          摆一个搜不到任何东西的搜索框是假 UI。等 §8.1 2️⃣ 建表后再加。 */}
      {appMode === "record" && !settingsOpen && (
      <div className={styles.headerControls}>
        {/* 搜索 + 时间/来源筛选同行（方案 A：筛选并入搜索行，省一行垂直空间） */}
        <div className={styles.searchFilterRow} data-tauri-drag-region="false">
          <SearchBox fill />
          <FilterDropdown
            label="时间"
            value={timeFilter}
            options={TIME_OPTIONS}
            onChange={(v) => setTimeFilter(v as TimeFilter)}
            auto
          />
          {/* 事件筛选（G3）曾在这里，2026-09-05 撤掉。原因不是它不能用，是入口放错了：
              ① 它与「时间」功能重叠（都在筛时间范围），且**共用同一个 `timeFilter` state**，
                天然互斥；选中事件后「时间」会退回显示「时间」（`range:` 匹配不上任何时间选项），
                这是两者耦合的唯一可见线索，很隐晦；
              ② 真实数据下它有 48 项，在里面滚找「那一阵」未必比直接搜关键词便宜；
              ③ 540 宽下顶栏已经很挤，它占的那一格是实打实的。
              🔴 后端的 `range:` 支持（`time_bound`）与分段纯函数（`lib/events.ts`）**都留着**：
              每日整理在用分段，而 `range:` 是日后把这个能力挪进「今日整理」时候的现成地基。 */}
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
      )}
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
function FilterDropdown<T extends string>({ label, value, options, onChange, auto, onOpen }: {
  label: string; value: T; options: { key: T; label: string }[]; onChange: (v: T) => void; auto?: boolean;
  /** 展开时回调。给选项需要现拉的下拉用（事件筛选）——
     *  挂在 mount 上会白白多一次启动查询，而挂在 historyVersion 上则每复制一条就重拉。 */
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => setOpen(false), []);
  useClickOutside(ref, closeMenu, open);

  const activeLabel = options.find((o) => o.key === value)?.label || label;

  return (
    <div className={`${styles.filterDropdown}${auto ? ` ${styles.filterDropdownAuto}` : ""}`} ref={ref} data-tauri-drag-region="false">
      <button className={styles.filterDropdownBtn} onClick={() => { if (!open) onOpen?.(); setOpen(!open); }}>
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

  const closeMenu = useCallback(() => setOpen(false), []);
  useClickOutside(ref, closeMenu, open);

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
    // historyLen 看着多余，实则是 history 的廉价代理：history 每次 store 更新都换引用，
    // 直接依赖它等于不缓存；删掉 historyLen 则会让这个 memo 永不更新。
    // 代价：条数不变但某条的 source 被改了不会重算（已知取舍）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyLen, workspace]);

  // source → source_icon 的快速查找表
  const sourceIconMap = useMemo(() => {
    const map = new Map<string, string | null>();
    sources.forEach(([source, icon]) => map.set(source, icon));
    return map;
  }, [sources]);

  // 当前选中来源的 source_icon
  const selectedSourceIcon = value ? sourceIconMap.get(value) ?? null : null;

  // 当前选中来源的图标与显示名：双模式解析走 useSourceIcon（规则 #11）。
  // displayName / emoji 也一并由它给，不再单调 cleanSourceName / getSourceIcon
  // —— 那两个本来就是 resolveSource 的包装，分开调等于解析两次。
  const { displayName, emoji, realIconUrl } = useSourceIcon(value, selectedSourceIcon);

  const activeLabel = useMemo(() => {
    if (!value) return "全部来源";
    if (realIconUrl) {
      return <><img src={realIconUrl} alt="" className={styles.filterDropdownIcon} /> {displayName}</>;
    }
    return <>{emoji && <span>{emoji}</span>} {displayName}</>;
  }, [value, displayName, emoji, realIconUrl]);

  return (
    <div className={`${styles.filterDropdown}${auto ? ` ${styles.filterDropdownAuto}` : ""}`} ref={ref} data-tauri-drag-region="false">
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

  useClickOutside(ref, onClose);

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
