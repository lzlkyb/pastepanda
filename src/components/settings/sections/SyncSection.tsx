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
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronRight } from "lucide-react";
import { openSettingsTab } from "@/lib/openSettings";
import { SettingTile } from "../ToggleRow";
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
  const gotoAbout = () => openSettingsTab("about");
  const onRowKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      gotoAbout();
    }
  };
  return (
    <>
      <div className={styles.sSection}>同步与互联</div>
      {/* 手机 App 入口：多数用户只在电脑端，这里给一条到「关于 → 手机 App 下载卡」的二次发现路径。
          整行是跳转按钮（点击/回车都切到关于页，卡片就在该页分割线下方第一屏）。 */}
      <div
        className={styles.sRow}
        role="button"
        tabIndex={0}
        onClick={gotoAbout}
        onKeyDown={onRowKey}
        style={{ cursor: "pointer" }}
      >
        <SettingTile hue="brand">📱</SettingTile>
        <div className={styles.sRowBody}>
          <div className={styles.sRowLabel}>在手机上安装 PastePanda</div>
          <div className={styles.sRowDesc}>扫码下载安卓 App · 手机连这台电脑远程取用</div>
        </div>
        {/* 行末 last-child 会吃 `.sRow > :last-child` 的 min-width:72——直接用 svg 会被撑扁变形，
            套一层 span 让 svg 保持 16px、由这个 72px 列把它贴右排。 */}
        <span>
          <ChevronRight size={16} color="var(--text-muted)" />
        </span>
      </div>
      <LanSyncSection config={config} updateAndSave={updateAndSave} />
      <KbSyncSection config={config} updateAndSave={updateAndSave} />
      <RcSection config={config} updateAndSave={updateAndSave} filter={filter} />
    </>
  );
}
