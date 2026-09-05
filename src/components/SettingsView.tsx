import { Fragment } from "react";
import { ArrowLeft, Settings as SettingsIcon, Search as SearchIcon } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { GeneralTab } from "@/components/settings/GeneralTab";
import { HelpTabContent } from "@/components/settings/HelpTabContent";
import { AboutTabContent } from "@/components/settings/AboutTabContent";
import { AiTab } from "@/components/settings/AiTab";
import { McpTab } from "@/components/settings/McpTab";
import { LazyMount } from "@/components/settings/LazyMount";
import { SETTINGS_SECTIONS, type SettingsNavEntry } from "@/components/settings/sections/meta";
import type { SettingsTabName } from "@/lib/openSettings";
import { useSettingsSearch } from "@/hooks/useSettingsSearch";
import { useSettingsShell } from "@/hooks/useSettingsShell";
import { useSettingsNav } from "@/hooks/useSettingsNav";
import styles from "./Settings.module.css";

/**
 * 设置页（原 496 行的 `SettingsDialog`/`SettingsView`，现在只管编排与 JSX）。
 *
 * 三块职责各自成 hook（规则 #7 / #11）：
 * - `useSettingsShell` —— 数据与操作（保存串行、导出导入、清理、恢复默认）
 * - `useSettingsNav`   —— 菜单高亮、平滑跳转、scroll-spy
 * - `useSettingsSearch`—— 搜索关键字与就地 DOM 过滤
 *
 * ❗ 菜单项（七个分区 + 四个页）的**顺序与文字**全部收在 `sections/meta.ts`，
 * 本文件不再自己拼一份——scroll-spy 与跳转都依赖「数组顺序＝滚动顺序」。
 *
 * 这里没有断点判断。菜单宽度全靠 CSS 的百分比 + 夹值（占 20%，128–220px），
 * 文字始终显示。曾经有过一个 600px 断点用来把菜单收成图标条，已废弃：
 * 只剩图标用户看不懂是哪一项。
 */
export function SettingsView({ open, onClose, initialTab }: {
  open: boolean;
  onClose: () => void;
  initialTab?: SettingsTabName;
}) {
  // 搜索框在标题栏（本组件渲染），而装设置行的容器在 GeneralTab 里，靠 ref 对接
  const search = useSettingsSearch();
  /** 搜索态：右栏看到的是跨分区结果，此时菜单不该再高亮某一项（那会误导） */
  const searching = search.filter.trim() !== "";

  const sh = useSettingsShell(open);
  const isBlossom = sh.config.theme === "blossom";
  const { nav, navItems, bodyRef, handleNavPick } = useSettingsNav({
    open, initialTab, blossom: isBlossom, searching, sectionClass: styles.sSection,
  });

  /** 菜单一项。**文字始终显示**——只有图标的话用户看不懂是哪一项 */
  const navItem = (n: SettingsNavEntry) => {
    const dot = n.key === "about" && sh.hasAboutDot && nav !== "about";
    return (
      <button key={n.key}
        className={`${styles.settingsNavItem}${!searching && nav === n.key ? ` ${styles.settingsNavItemActive}` : ""}`}
        onClick={() => handleNavPick(n.key)}>
        <span className={styles.settingsNavIcon}>{n.icon}</span>
        <span className={styles.settingsNavLabel}>{n.label}</span>
        {dot && <span className={styles.tabDot} />}
      </button>
    );
  };

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
        {/* 左侧菜单：7 个分区 + 分隔线 + 4 个独立页。
            宽度全交给 CSS（占 20%，夹在 128–220px），所以这里不需要任何断点判断。 */}
        <div className={styles.settingsNav}>
          {navItems.map((n, i) => (
            <Fragment key={n.key}>
              {i === SETTINGS_SECTIONS.length && <div className={styles.settingsNavSep} />}
              {navItem(n)}
            </Fragment>
          ))}
        </div>

        {/* 右侧详情：**全部 11 项排在同一根滚动里**，滑到哪一节菜单就高亮哪一项。
            前七个分区在 GeneralTab 里（它们得待在搜索容器内，那里的 children 必须是一层扁平的行）；
            AI/MCP/帮助/关于 是整块组件，放在容器**之外**，自己带分区标题。 */}
        <div className={styles.settingsContent} ref={bodyRef}>
          <GeneralTab
            config={sh.config} updateConfig={sh.updateConfig} updateAndSave={sh.updateAndSave}
            stats={sh.stats} statsError={sh.statsError} onRetryStats={sh.retryStats}
            expiredCount={sh.expiredCount}
            tabStyle={sh.tabStyle} handleSwitchTabStyle={sh.handleSwitchTabStyle}
            handleExport={sh.handleExport} handleImport={sh.handleImport} handleCleanup={sh.handleCleanup}
            exporting={sh.exporting} importing={sh.importing}
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
              <HelpTabContent config={sh.config} appName={sh.appName} appVersion={sh.appVersion} />
              <div className={styles.sSection}>关于</div>
              <AboutTabContent appName={sh.appName} appVersion={sh.appVersion} />
            </>
          )}
        </div>
      </div>

      <div className={styles.sFooter}>
        <div className={styles.sFooterRow}>
          <button onClick={() => sh.setShowResetConfirm(true)} className={styles.sResetBtn} title="将所有设置恢复为默认值">恢复默认设置</button>
          <button onClick={onClose} className={styles.sSaveBtn}>退出设置</button>
        </div>
        <div className={styles.sFooterMeta}>
          <span className={styles.sAutoSaveHint}>所有设置修改后自动保存</span>
        </div>
      </div>

      <ConfirmDialog key="cleanup-confirm"
        open={sh.showCleanupConfirm}
        title="确认清理"
        message={`将删除 ${sh.expiredCount} 条超过 ${sh.cleanupDays} 天的过期记录，确认？`}
        confirmText="确认清理"
        variant="danger"
        onConfirm={sh.executeCleanup}
        onCancel={() => sh.setShowCleanupConfirm(false)}
      />
      <ConfirmDialog key="reset-confirm"
        open={sh.showResetConfirm}
        title="恢复默认设置"
        message="将把主题、热键、自动清理等行为设置恢复为默认值（工作区数据保留），确认？"
        confirmText="恢复默认"
        onConfirm={sh.handleResetDefaults}
        onCancel={() => sh.setShowResetConfirm(false)}
      />
    </div>
  );
}
