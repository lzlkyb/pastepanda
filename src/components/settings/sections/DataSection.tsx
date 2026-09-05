import type { AppConfig } from "@/stores/appStore";
import { HelpTooltip } from "@/components/HelpTooltip";
import { ToggleRow } from "../ToggleRow";
import { NoteVaultRows } from "../NoteVaultRows";
import type { SettingsData } from "@/hooks/useSettingsData";
import styles from "../../Settings.module.css";

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
}

// 🔴 必须返回片段，原因同 StatsSection。
export function DataSection({
  config, updateAndSave, expiredCount,
  handleExport, handleImport, handleCleanup, exporting, importing,
  setShowDeepClean,
}: DataSectionProps) {
  return (
    <>
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
      {/* 笔记的 Markdown 目录导出/导入（B1 #5）。上面那两行是历史记录的 JSON，两回事 */}
      <NoteVaultRows />
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
      {/* v6.1 自我净化开关：保护常用内容不过期。关掉即退回"超期必清"旧行为 */}
      <ToggleRow
        icon="🛟"
        gradient="linear-gradient(135deg, #10B981, #059669)"
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
    </>
  );
}
