import { AppConfig } from "@/stores/appStore";
import { StatsDetail } from "@/lib/api";
import { useSettingsData } from "@/hooks/useSettingsData";
import { AppearanceSection } from "./sections/AppearanceSection";
import { CopyPasteSection } from "./sections/CopyPasteSection";
import { WindowEditorSection } from "./sections/WindowEditorSection";
import { HotkeySection } from "./sections/HotkeySection";
import { CaptureSection } from "./sections/CaptureSection";
import { IslandSection } from "./sections/IslandSection";
import { DataSection } from "./sections/DataSection";
import { SyncSection } from "./sections/SyncSection";
import { StatsSection } from "./sections/StatsSection";
import type { SettingsSearch } from "@/hooks/useSettingsSearch";
import { SETTINGS_PAGES, type SettingsPageKey } from "./sections/meta";
import { DeepCleanDialog } from "@/components/DeepCleanDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { WeekReportDialog } from "@/components/WeekReportDialog";
import styles from "../Settings.module.css";

interface GeneralTabProps {
  config: AppConfig;
  updateConfig: (partial: Record<string, unknown>) => void;
  updateAndSave: (partial: Record<string, unknown>) => Promise<void>;
  stats: StatsDetail | null;
  /** 审查：统计加载失败标记 + 重试（不再永久 spinner） */
  statsError?: boolean;
  onRetryStats?: () => void;
  /** 过期记录数（后端按清理条件精确统计，含"未置顶+超期"） */
  expiredCount: number;
  tabStyle: string;
  handleSwitchTabStyle: (style: "segmented" | "circle") => void;
  handleExport: () => Promise<void>;
  handleImport: () => Promise<void>;
  handleCleanup: () => Promise<void>;
  exporting?: boolean;
  importing?: boolean;
  /**
   * 搜索状态与 ref。搜索框本身在**左侧菜单顶部**（SettingsView 渲染），
   * 而装设置行的容器在这里——两边靠这组 ref 对接。
   */
  search: SettingsSearch;
  /** 空态里那四个「整块页面」的跳转：与左菜单同一条路径（清关键词 + 跳） */
  onJumpPage: (key: SettingsPageKey) => void;
}

/**
 * 设置页左列（九个分区）的**编排层**：只负责分区顺序与弹窗，
 * 具体设置行在 sections/ 下按分区分文件，共用状态在 useSettingsData。
 *
 * 🔴 九个分区组件都返回 <>…</> 片段，所以 settingsSections 容器的 children
 * 仍然是「分区标题 + 设置行」一层扁平结构——搜索过滤就靠这个。
 * （容器里还会有一批**小节标题**：同样用 `sSection`、同样不入左菜单，
 * 见 `sections/meta.ts` 的 `SETTINGS_SUBSECTIONS`。）
 */
export function GeneralTab({
  config, updateAndSave, stats, statsError, onRetryStats, expiredCount,
  tabStyle, handleSwitchTabStyle,
  handleExport, handleImport, handleCleanup,
  exporting, importing, search, onJumpPage,
}: GeneralTabProps) {
  // 各分区共用的状态与副作用统一收口到 useSettingsData（规则 #11）
  const {
    cleanupDays, pendingCleanup, setPendingCleanup, handlePickCleanupDays,
    trashDays, pendingTrash, setPendingTrash, handlePickTrashDays,
    showDeepClean, setShowDeepClean,
    showWeekReport, setShowWeekReport,
    srcOpen, setSrcOpen,
    loadedAt, chains, dash,
    mdAssoc, mdAssocBusy, handleMdAssocToggle,
  } = useSettingsData({ config, updateAndSave, stats });

  return (
    <>
      {/* 🔴 九个分区**全部**排在一根滚动里，不按菜单选择只渲染一个。
          两个原因：① 菜单靠滚动位置自动高亮（scroll-spy），全挂载才量得到位置；
          ② 搜索是对已挂载 DOM 逐行过滤的，只挂一个分区就搜不到别的。
          分区顺序必须与 sections/meta.ts 里的 SETTINGS_SECTIONS 一致。 */}
      <div ref={search.containerRef} className={styles.settingsSections}>
        <AppearanceSection
          config={config} updateAndSave={updateAndSave}
          tabStyle={tabStyle} handleSwitchTabStyle={handleSwitchTabStyle}
        />
        <CopyPasteSection config={config} updateAndSave={updateAndSave} />
        <WindowEditorSection
          config={config} updateAndSave={updateAndSave}
          mdAssoc={mdAssoc} mdAssocBusy={mdAssocBusy} handleMdAssocToggle={handleMdAssocToggle}
        />
        <HotkeySection config={config} updateAndSave={updateAndSave} />
        <CaptureSection config={config} updateAndSave={updateAndSave} chains={chains} />
        <IslandSection config={config} updateAndSave={updateAndSave} />
        <DataSection
          config={config} updateAndSave={updateAndSave} expiredCount={expiredCount}
          handleExport={handleExport} handleImport={handleImport} handleCleanup={handleCleanup}
          exporting={exporting} importing={importing}
          setShowDeepClean={setShowDeepClean}
          cleanupDays={cleanupDays} handlePickCleanupDays={handlePickCleanupDays}
          trashDays={trashDays} handlePickTrashDays={handlePickTrashDays}
        />
        <SyncSection config={config} updateAndSave={updateAndSave} filter={search.filter} />
        <StatsSection
          config={config} stats={stats} statsError={statsError} onRetryStats={onRetryStats}
          setShowWeekReport={setShowWeekReport}
          srcOpen={srcOpen} setSrcOpen={setSrcOpen} loadedAt={loadedAt} dash={dash}
        />
      </div>
      {/* 空态不能只说「没找到」：这里用户有明确动作能让列表重新出现（清掉搜索），
          所以必须把那个动作直接摆出来，并给一个可照拄的词例。
          ❗ useSettingsSearch 只改这个节点的 style.display，不改它的子节点，加按钮安全。 */}
      <div ref={search.noResultRef} className={styles.settingsNoResult} style={{ display: "none" }}>
        😕 没有找到与「{search.filter}」匹配的设置项
        <div className={styles.settingsNoResultHint}>清掉搜索看全部设置，或换个词试试，比如「主题」「热键」</div>
        {/* 🔴 「没有匹配项」有第二种成因：这四块是**整块组件**，不在这个逐行过滤的
            容器里（见 SettingsView：它们排在 settingsSections 之外），所以搜「密钥」「模型」
            「MCP」天然是 0 结果。不写这一句，空态就是在骗人——而用户明明在界面上
            看得见「AI」那一页里有个密钥框。按钮走左菜单同一个 handleNavPick：
            先清关键词再跳，否则落点标题被过滤藏着，点了没反应（本轮 P0-1 的同一件事）。 */}
        <div className={styles.settingsNoResultHint}>
          「AI / MCP / 帮助 / 关于」是整块页面，不参与逐行搜索——可直接跳过去：
        </div>
        <div className={styles.settingsNoResultPages}>
          {SETTINGS_PAGES.map((pg) => (
            <button key={pg.key} className={styles.settingsNoResultBtn} onClick={() => onJumpPage(pg.key)}>
              {pg.icon} {pg.label}
            </button>
          ))}
        </div>
        <button className={styles.settingsNoResultBtn} onClick={() => search.setFilter("")}>
          清空搜索
        </button>
      </div>
      {/* 深度清理弹窗：portal 到 body，open 门控显隐 */}
      <DeepCleanDialog open={showDeepClean} onClose={() => setShowDeepClean(false)} />
      {/* v6.4 E 剪贴板周报 */}
      {showWeekReport && <WeekReportDialog onClose={() => setShowWeekReport(false)} />}
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
      {/* 回收站保留天数改短的二次确认（W1 / R3）。同上面那个的理由，
          但这边销毁的是笔记连历史版本，必须说清楚。 */}
      <ConfirmDialog key="trash-days-confirm"
        open={!!pendingTrash}
        title="确认缩短回收站保留天数"
        message={pendingTrash
          ? (pendingTrash.count === null
              ? `改为保留 ${pendingTrash.days} 天后，回收站里超期的笔记与它们的历史版本将在下次自动清理时被永久删除，无法撤销（本次未能统计出具体条数）。确认？`
              : `改为保留 ${pendingTrash.days} 天后，回收站里将有 ${pendingTrash.count} 条笔记与它们的历史版本在下次自动清理时被永久删除，无法撤销。确认？`)
          : ""}
        confirmText="确认修改"
        variant="danger"
        onConfirm={() => {
          const days = pendingTrash?.days;
          setPendingTrash(null);
          if (days !== undefined) void updateAndSave({ note_trash_days: days });
        }}
        onCancel={() => setPendingTrash(null)}
      />
    </>
  );
}
