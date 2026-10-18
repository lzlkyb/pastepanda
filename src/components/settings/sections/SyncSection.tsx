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
  updateAndSave: (partial: Record<string, unknown>) => Promise<boolean>;
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
      <div className={styles.sSection}>设备与连接</div>
      <LanSyncSection config={config} updateAndSave={updateAndSave} />
      <KbSyncSection config={config} updateAndSave={updateAndSave} />
      <RcSection config={config} updateAndSave={updateAndSave} filter={filter} />
      <div data-settings-parent="设备与连接" className={styles.sSection}>手机安装</div>
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
    </>
  );
}
