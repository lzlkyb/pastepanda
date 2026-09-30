/**
 * 设置页「同步与互联」分区（2026-09-29 分区重排 方案A）。
 *
 * 三节原先各自占一个菜单项，而每节实际只有一行开关 + 一个条件渲染的面板，
 * 菜单却被撑成三项、翻起来全是空节。合并成一节，内部保留三个**小节标题**
 * （`LanSyncSection` / `KbSyncSection` / `RcSection` 原样搬入，一行不改）：
 * 三种同步是三条互不相干的授权，小节标题就是它们之间的墙。
 *
 * ❗ 三个旧 key 仍是合法锚点（`openSettingsTab("general", "rc")`）：
 * 归属表在 `sections/meta.ts` 的 `SETTINGS_SUBSECTIONS`，
 * 菜单亮「同步与互联」、右栅停在对应小节标题上。
 *
 * 🔴 必须返回片段，原因同 StatsSection；三个子组件也返回片段，children 依旧扁平。
 */
import type { AppConfig } from "@/stores/appStore";
import { LanSyncSection } from "./LanSyncSection";
import { KbSyncSection } from "./KbSyncSection";
import { RcSection } from "./RcSection";
import styles from "../../Settings.module.css";

interface SyncSectionProps {
  config: AppConfig;
  updateAndSave: (partial: Record<string, unknown>) => Promise<void>;
  /** 搜索关键词：透传给「远程电脑」的四个折叠组——搜索期间强制全展开。 */
  filter: string;
}

export function SyncSection({ config, updateAndSave, filter }: SyncSectionProps) {
  return (
    <>
      <div className={styles.sSection}>同步与互联</div>
      <LanSyncSection config={config} updateAndSave={updateAndSave} />
      <KbSyncSection config={config} updateAndSave={updateAndSave} />
      <RcSection config={config} updateAndSave={updateAndSave} filter={filter} />
    </>
  );
}
