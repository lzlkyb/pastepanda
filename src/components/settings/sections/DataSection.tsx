import { primaryShortcutLabel } from "@/lib/utils";
import type { AppConfig } from "@/stores/appStore";
import { HelpTooltip } from "@/components/HelpTooltip";
import { ToggleRow, SettingTile } from "../ToggleRow";
import { NoteVaultRows } from "../NoteVaultRows";
import type { SettingsData } from "@/hooks/useSettingsData";
import styles from "../../Settings.module.css";

const CLEANUP_OPTIONS = [
  { label: "关", value: 0 },
  { label: "7天", value: 7 },
  { label: "15天", value: 15 },
  { label: "30天", value: 30 },
  { label: "60天", value: 60 },
];

interface DataSectionProps {
  config: AppConfig;
  updateAndSave: (partial: Record<string, unknown>) => Promise<void>;
  expiredCount: number;
  handleExport: () => Promise<void>;
  handleImport: () => Promise<void>;
  handleCleanup: () => Promise<void>;
  exporting?: boolean;
  importing?: boolean;
  setShowDeepClean: SettingsData["setShowDeepClean"];
  cleanupDays: SettingsData["cleanupDays"];
  handlePickCleanupDays: SettingsData["handlePickCleanupDays"];
  trashDays: SettingsData["trashDays"];
  handlePickTrashDays: SettingsData["handlePickTrashDays"];
}

// 🔴 必须返回片段，原因同 StatsSection。
// 2026-09-29 分区重排：两行「保留天数」从「通用」搬了进来——它们管的是记录留多久，
// 而受它管的「保护常用内容 / 清理过期记录 / 深度清理」一直在这里，原先隔着六个分区。
export function DataSection({
  config, updateAndSave, expiredCount,
  handleExport, handleImport, handleCleanup, exporting, importing,
  setShowDeepClean, cleanupDays, handlePickCleanupDays, trashDays, handlePickTrashDays,
}: DataSectionProps) {
  return (
    <>
      {/* ── 数据管理 ── */}
      <div className={styles.sSection}>数据管理</div>
      <div className={styles.sRow}>
        <SettingTile hue="save">🗑</SettingTile>
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
              aria-pressed={cleanupDays === opt.value}
              onClick={() => { void handlePickCleanupDays(opt.value); }}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      {/* 回收站保留天数（W1 / R3）。紧跟在自动清理后面，但文案必须把
          「这是笔记、那是剪贴板」说清楚——两行长得一样，误认了就是删错东西。 */}
      <div className={styles.sRow}>
        <SettingTile hue="save">♻</SettingTile>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>
            笔记回收站
            <HelpTooltip
              tooltip="删掉的笔记在回收站保留多久，到期自动销毁"
              detailTitle="笔记回收站"
              detail={<>
                <p>删掉的笔记不会立即消失，而是进入<b>知识库侧栏底部的回收站</b>，随时可以恢复。</p>
                <p>📌 连它的<b>历史版本与标签一起保留</b>，恢复后原样回来</p>
                <p>📌 回收站里的笔记<b>不参与搜索</b>，也不算进笔记总数</p>
                <p>⚠️ 这与上面的「自动清理」<b>是两回事</b>：那个管剪贴板历史，这个管笔记</p>
                <p>⚠️ 设为「关」则永久保留，只能在回收站里手动清</p>
              </>}
            />
          </div>
          <div className={`${styles.sRowDesc}`}>删掉的笔记先进回收站，超过该天数后自动销毁（不可恢复）</div>
        </div>
        <div className={styles.sCleanup}>
          {CLEANUP_OPTIONS.map((opt, idx) => (
            <button key={`trash-${opt.value ?? idx}`}
              className={`${styles.sCleanupOpt}${trashDays === opt.value ? ` ${styles.active}` : ""}`}
              aria-pressed={trashDays === opt.value}
              onClick={() => { void handlePickTrashDays(opt.value); }}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      {/* v6.1 自我净化开关：保护常用内容不过期。关掉即退回"超期必清"旧行为 */}
      <ToggleRow
        icon="💎"
        hue="save"
        label="保护常用内容"
        desc="打标签 / 粘贴过 / 搜索找回过的内容不参与自动清理"
        value={config.preserve_valued_content}
        onChange={(v) => updateAndSave({ preserve_valued_content: v })}
        tooltip="开启后打标签/粘贴过/搜索找回过的内容不参与自动清理"
        detailTitle="保护常用内容"
        detail={<>
          <p>开启后，满足任一「有价值」信号的内容即使超过保留天数也<b>不会被自动清理</b>：</p>
          <p>📌 被打过标签（手动或自动）</p>
          <p>📌 被粘贴过（真正用上了）</p>
          <p>📌 被搜索找回过</p>
          <p>关闭则退回旧行为：超过保留天数、未置顶的记录一律清理。设置页的过期数量会相应变化。</p>
        </>}
      />
      <div className={styles.sRow}>
        <SettingTile hue="save">🗑</SettingTile>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>清理过期记录</div>
          <div className={`${styles.sRowDesc}`}>
            {expiredCount > 0
              ? `${expiredCount} 条记录已过期`
              : cleanupDays > 0
                ? `暂无过期记录 · 超过 ${cleanupDays} 天的记录才会算进来`
                : "自动清理已关闭 · 记录不会过期，要一次性清空用下方「深度清理」"}
          </div>
        </div>
        {/* 无过期记录时必须 disabled：handleCleanup 首行就是 `if (expiredCount <= 0) return;`，
            而 .sAction 自带边框 + hover 变强调色 + cursor:pointer，静止和 hover 都在说「我能点」。 */}
        <button
          className={`${styles.sAction}${expiredCount > 0 ? ` ${styles.danger}` : ""}`}
          onClick={handleCleanup}
          disabled={expiredCount === 0}
        >
          {expiredCount > 0 ? `清理 ${expiredCount} 条` : "无过期"}
        </button>
      </div>
      <div className={styles.sRow}>
        <SettingTile hue="privacy">🛟</SettingTile>
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
                <p>{`💡 实时统计匹配条数，可展开预览；置顶记录自动跳过，删除后可 ${primaryShortcutLabel("z")} 撤销`}</p>
              </>}
            />
          </div>
          <div className={`${styles.sRowDesc}`}>按时间 / 类型 / 来源组合条件清理，支持预览与撤销</div>
        </div>
        <button className={styles.sAction} onClick={() => setShowDeepClean(true)}>打开</button>
      </div>
      <div className={styles.sRow}>
        <SettingTile hue="save">📦</SettingTile>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>导出数据</div>
          {/* 实际默认导出的是 Excel：handleExport 的 filters 顺序是 xlsx → csv → json，
              系统保存对话框取第一项做默认扩展名。原描述写死「JSON」，界面说的和实际发生的不是一回事。 */}
          <div className={`${styles.sRowDesc}`}>导出为 Excel / CSV / JSON，在保存对话框里选格式</div>
        </div>
        <button className={styles.sAction} onClick={handleExport} disabled={exporting}>
          {exporting ? <span className={styles.sActionLoading}>导出中…</span> : "导出"}
        </button>
      </div>
      <div className={styles.sRow}>
        <SettingTile hue="save">📥</SettingTile>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>导入数据</div>
          <div className={`${styles.sRowDesc}`}>从 JSON 文件导入历史记录</div>
        </div>
        <button className={styles.sAction} onClick={handleImport} disabled={importing}>
          {importing ? <span className={styles.sActionLoading}>导入中…</span> : "导入"}
        </button>
      </div>
      {/* 笔记的 Markdown 目录导出/导入（B1 #5）。上面那两行是历史记录的 JSON，两回事 */}
      <NoteVaultRows />
    </>
  );
}
