import { useState, useEffect, useRef, useMemo } from "react";
import { ArrowLeft, Settings as SettingsIcon, Search as SearchIcon } from "lucide-react";
import { useAppStore, HistoryItem, DEFAULT_CONFIG } from "@/stores/appStore";
import { ConfirmDialog } from "@/components/ConfirmDialog";
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
import { McpTab } from "@/components/settings/McpTab";
import { LazyMount } from "@/components/settings/LazyMount";
import type { SettingsTabName } from "@/lib/openSettings";
import { SETTINGS_SECTIONS, type SettingsSectionKey } from "@/components/settings/sections/meta";
import { useSettingsSearch } from "@/hooks/useSettingsSearch";
import styles from "./Settings.module.css";

/**
 * tab 类型从 `@/lib/openSettings` 引（与 `App.tsx` 共用一份）。
 *
 * ❗ `"mcp"` 是 A-61 ③ 新增的：知识库 MCP 服务原先在 `GeneralTab` 第 920 行，
 *   现在知识模式中栏的「⋯」菜单能通过 `initialTab` 直接跳到这一页。
 *   顺带一个好处：下面的 tab 面板是**条件渲染**的，所以 `useMcpServer`
 *   的 5s 轮询只在真的看这一页时才跑（以前打开设置页就跑）。
 */
type SettingsTab = SettingsTabName;

/** 左导航的一项：要么是「通用」下的一个分区，要么是 AI/MCP/帮助/关于 四个页 */
type NavKey = SettingsSectionKey | Exclude<SettingsTab, "general">;

// ❗ 这里没有断点判断。菜单宽度全靠 CSS 的百分比 + 夹值（占 20%，128–220px），
// 文字始终显示。曾经有过一个 600px 断点用来把菜单收成图标条，已废弃：
// 只剩图标用户看不懂是哪一项。

export function SettingsView({ open, onClose, initialTab }: { open: boolean; onClose: () => void; initialTab?: SettingsTab }) {
  const config = useAppStore((s) => s.config);
  const updateConfig = useAppStore((s) => s.updateConfig);
  /**
   * 当前菜单项。🔴 **不允许为 null**：之前初值是 null，结果刚打开设置右栏整块空白，
   * 看上去像 bug，实际是「还没点过菜单」。恒定左右布局下没有「未选中」这个态。
   */
  const [nav, setNav] = useState<NavKey>(SETTINGS_SECTIONS[0].key);
  // 搜索框在左侧菜单顶部（本组件渲染），而装设置行的容器在 GeneralTab 里，靠 ref 对接
  const search = useSettingsSearch();
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
  const bodyRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const { status: updateStatus } = useUpdate();

  /** 关于 tab 红点：有新版本可用 或 有未查看过的更新日志 */
  const hasAboutDot = useMemo(() => {
    if (updateStatus === "available" || updateStatus === "ready" || updateStatus === "installed") return true;
    const lastSeen = getLastSeenVersion();
    return lastSeen ? hasUnseenEntries(CHANGELOG, lastSeen) : CHANGELOG.length > 0;
  }, [updateStatus]);

  useEffect(() => {
    if (open) {
      // v6.4 审查：#10 从变换中心跳转过来时直接定位到指定页；
      // 不传或传 "general" 就落在第一个分区（右栏永远不能是空的）。
      setNav(initialTab && initialTab !== "general" ? initialTab : SETTINGS_SECTIONS[0].key);
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

  /** 点菜单后待执行的滚动目标（等目标渲染出来再滑）。包含 AI/MCP/帮助/关于 */
  const pendingScrollRef = useRef<NavKey | null>(null);
  /**
   * 平滑期间抑制 scroll-spy 的截止时间。
   * 不加这个的话：点「数据管理」→ 开始平滑 → 途中扫过「快捷键」→ spy 把 nav 改成快捷键，
   * 菜单高亮会在滑动过程中乱跳，最后停在错的项上。
   */
  const spyMutedUntilRef = useRef(0);

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
  /** 左导航的四个非「通用」页（原顶层 tab）。「通用」拆成了上面七个分区，不再占一项。 */
  const pageTabs: { key: Exclude<SettingsTab, "general">; label: string; icon: string }[] = [
    { key: "ai", label: "AI", icon: isBlossom ? "🌸" : "✨" },
    // 摆在 AI 后面：两者都是「跟 AI 有关」，但 AI 页管模型/密钥，
    // 本页管的是「让外部 AI 工具读写我的笔记」，方向相反。
    { key: "mcp", label: "MCP", icon: isBlossom ? "🩷" : "🧩" },
    { key: "help", label: "帮助", icon: isBlossom ? "💌" : "📖" },
    { key: "about", label: "关于", icon: isBlossom ? "💗" : "ℹ" },
  ];

  /** 搜索态：右栏看到的是跨分区结果，此时菜单不该再高亮某一项（那会误导） */
  const searching = search.filter.trim() !== "";

  /** 菜单全部 11 项（七个分区 + 四个页），**顺序即滚动顺序**，scroll-spy 与跳转都靠它 */
  const allNav: { key: NavKey; label: string; icon: string }[] = [...SETTINGS_SECTIONS, ...pageTabs];

  /**
   * 在滚动容器里找某一项的标题元素。靠**标题文字**对应——meta.ts 已声明
   * label 必须与分区标题逐字一致；AI/MCP/帮助/关于 的标题也按同一套文字渲染。
   * 用 querySelectorAll 而不是遍历 container.children：四个页的标题在搜索容器**之外**。
   */
  const findNavEl = (key: NavKey): HTMLElement | undefined => {
    const scroller = bodyRef.current;
    if (!scroller) return undefined;
    const label = allNav.find((n) => n.key === key)?.label;
    return Array.from(scroller.querySelectorAll<HTMLElement>("." + styles.sSection)).find(
      (el) => (el.textContent || "").trim() === label,
    );
  };

  const handleNavPick = (key: NavKey) => {
    setNav(key);
    if (key === "about" && CHANGELOG.length > 0) setLastSeenVersion(CHANGELOG[0].version);
    // 点菜单 → 平滑到那一节。不在这里直接滚：MCP 那块是按可见性懒挂载的，
    // 可能还没真正渲染出来，交给渲染后的 effect 去量位置。
    pendingScrollRef.current = key;
  };

  // 点菜单后真正执行滚动：放在渲染后，因为目标（尤其是懒挂载的 MCP）可能刚出现
  useEffect(() => {
    const key = pendingScrollRef.current;
    if (!key) return;
    pendingScrollRef.current = null;
    const scroller = bodyRef.current;
    const target = findNavEl(key);
    if (!scroller || !target) return;
    // 用 scrollTop 增量而不是 scrollIntoView：后者会连带滑动祖先容器，把整个窗口顶掉
    const top = scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    spyMutedUntilRef.current = performance.now() + 700;
    scroller.scrollTo({ top, behavior: "smooth" });
  });

  // scroll-spy：滑到哪一节，菜单就高亮哪一项（含 AI/MCP/帮助/关于）
  useEffect(() => {
    const scroller = bodyRef.current;
    // 搜索时大量行被隐藏、右栏是跨分区结果，此时跟随高亮只会添乱
    if (!scroller || searching) return;
    const onScroll = () => {
      if (performance.now() < spyMutedUntilRef.current) return;
      // 判定线放在可视区顶部下方 80px：标题刚滑过这条线就算「进入这一节」
      const line = scroller.getBoundingClientRect().top + 80;
      let current: NavKey | null = null;
      for (const el of Array.from(scroller.querySelectorAll<HTMLElement>("." + styles.sSection))) {
        // 被搜索隐掉的标题没有布局盒，位置恰好是 0，不跳过会把高亮拉到最后一项
        if (el.offsetParent === null) continue;
        if (el.getBoundingClientRect().top > line) break;
        // 认不出的标题（如 HotkeySection 内部的「转笔记模板」）直接跳过，
        // 保留上一个认得出的，否则滑到那里时菜单会突然掉高亮
        const hit = allNav.find((n) => n.label === (el.textContent || "").trim());
        if (hit) current = hit.key;
      }
      if (current) setNav((prev) => (prev === current ? prev : current));
    };
    onScroll();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searching]);

  /** 菜单一项。**文字始终显示**——只有图标的话用户看不懂是哪一项 */
  const navItem = (key: NavKey, icon: string, label: string, dot = false) => (
    <button key={key}
      className={`${styles.settingsNavItem}${!searching && nav === key ? ` ${styles.settingsNavItemActive}` : ""}`}
      onClick={() => handleNavPick(key)}>
      <span className={styles.settingsNavIcon}>{icon}</span>
      <span className={styles.settingsNavLabel}>{label}</span>
      {dot && <span className={styles.tabDot} />}
    </button>
  );

  /**
   * 左侧菜单：搜索框 + 7 个分区 + 4 个独立页。
   * 宽度全交给 CSS（占 20%，夹在 128–220px），所以这里不再需要任何断点判断。
   */
  const navList = (
    <div className={styles.settingsNav}>
      {SETTINGS_SECTIONS.map((s) => navItem(s.key, s.icon, s.label))}
      <div className={styles.settingsNavSep} />
      {pageTabs.map((t) => navItem(t.key, t.icon, t.label, t.key === "about" && hasAboutDot && nav !== "about"))}
    </div>
  );

  /**
   * 右侧详情：**全部 11 项排在同一根滚动里**，滑到哪一节菜单就高亮哪一项。
   *
   * 前七个分区在 GeneralTab 里（它们得待在搜索容器内，那里的 children 必须是一层扁平的行）；
   * AI/MCP/帮助/关于 是整块组件，放在容器**之外**，自己带分区标题。
   */
  const content = (
    <div className={styles.settingsContent} ref={bodyRef}>
      <GeneralTab
        config={config} updateConfig={updateConfig} updateAndSave={updateAndSave}
        stats={stats} statsError={statsError} onRetryStats={() => {
          setStatsError(false);
          getStatsDetail(config.current_workspace).then(setStats).catch(() => setStatsError(true));
        }} expiredCount={expiredCount}
        tabStyle={tabStyle} handleSwitchTabStyle={handleSwitchTabStyle}
        handleExport={handleExport} handleImport={handleImport} handleCleanup={handleCleanup}
        exporting={exporting} importing={importing}
        search={search}
      />
      {/* 搜索时隐掉这四块：它们不是「设置行」，不参与逐行过滤，
          留着会让搜索结果下面拖着四大块不相干的内容。 */}
      {!searching && (
        <>
          <div className={styles.sSection}>AI</div>
          <AiTab />
          <div className={styles.sSection}>MCP</div>
          {/* 🔴 MCP 必须懒挂载：useMcpServer 带 5s 轮询，直接挂等于一打开设置就轮询，
              会把 McpTab 当初搬出 GeneralTab 时做的那个优化撤销。详见 LazyMount 注释。 */}
          <LazyMount minHeight={220}><McpTab /></LazyMount>
          <div className={styles.sSection}>帮助</div>
          <HelpTabContent config={config} appName={appName} appVersion={appVersion} />
          <div className={styles.sSection}>关于</div>
          <AboutTabContent appName={appName} appVersion={appVersion} />
        </>
      )}
    </div>
  );

  return (
    <div className={styles.settingsView}>
      <div className={styles.settingsViewHeader}>
        {/* 恒定左右布局没有「级」，这个按钮就是直接退出设置（Esc 同义）。
            图标走 lucide、尺寸与圆角对齐 .sAction，与软件其它按钮一致。 */}
        <button className={styles.settingsViewBack} onClick={onClose} title="返回（Esc）">
          <ArrowLeft size={13} strokeWidth={2.4} />
          返回
        </button>
        {/* 菜单里已经高亮了当前项，标题不必重复；搜索时右栏是跨分区结果，跟着改。
            ❗ 图标用 lucide 而不是 ⚙ 字形：后者粗细/基线随系统字体变，跟旁边文字对不齐，
            也与顶栏那排 SVG 图标不是一个风格。 */}
        <h2 className={styles.settingsViewTitle}>
          {searching
            ? <><SearchIcon size={14} strokeWidth={2.2} />搜索结果</>
            : <><SettingsIcon size={14} strokeWidth={2.2} />设置</>}
        </h2>
        {/* 🔴 搜索框放在标题栏，不在菜单也不在详情里：它搜的是**全部**设置，
            就应当在两栏之上。放菜单里像「搜菜单」，放详情里像「搜当前分区」，都不对。
            而且菜单只有 128px，输入框只剩 ~70px 可用，根本看不全。 */}
        <div className={styles.settingsSearchBox}>
          <span className={styles.settingsSearchIcon}><SearchIcon size={13} strokeWidth={2.2} /></span>
          <input
            className={styles.settingsSearchInput}
            type="text"
            value={search.filter}
            placeholder="搜索设置"
            onChange={(e) => search.setFilter(e.target.value)}
          />
          {/* 命中计数：子节点故意留空，文本由 useSettingsSearch 的 effect 直接写入 */}
          <span ref={search.countRef} className={styles.settingsSearchCount} />
          {search.filter && (
            <button className={styles.settingsSearchClear} onClick={() => search.setFilter("")} title="清空搜索">✕</button>
          )}
        </div>
      </div>

      <div className={styles.settingsViewBody}>
        {/* 恒定左右：菜单与详情始终同时在场，窄屏只是菜单收成图标条。
            不再有「一级/二级」两套渲染分支。 */}
        {navList}
        {content}
      </div>

      <div className={styles.sFooter}>
        <div className={styles.sFooterRow}>
          <button onClick={() => setShowResetConfirm(true)} className={styles.sResetBtn} title="将所有设置恢复为默认值">恢复默认设置</button>
          <button onClick={onClose} className={styles.sSaveBtn}>退出设置</button>
        </div>
        <div className={styles.sFooterMeta}>
          <span className={styles.sAutoSaveHint}>所有设置修改后自动保存</span>
        </div>
      </div>

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
    </div>
  );
}
