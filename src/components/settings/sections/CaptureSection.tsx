/**
 * 设置页「截图与栈」分区（2026-09-29 分区重排 方案A）。
 *
 * 截图与粘贴栈是同一条「捕获 → 攒 → 贴」链路的上下游，各自都不足以单开一节，
 * 于是合成一节、内部用「粘贴栈」小节标题分开。两组行分别留在自己的文件里
 * （`ScreenshotRows` / `StackRows`），这里只负责节标题与顺序。
 *
 * 🔴 必须返回片段，原因同 StatsSection：两个子组件也返回片段，容器 children 依旧扁平。
 */
import type { AppConfig } from "@/stores/appStore";
import { ScreenshotRows } from "./ScreenshotRows";
import { StackRows } from "./StackRows";
import type { SettingsData } from "@/hooks/useSettingsData";
import styles from "../../Settings.module.css";

interface CaptureSectionProps {
  config: AppConfig;
  updateAndSave: (partial: Record<string, unknown>) => Promise<void>;
  chains: SettingsData["chains"];
}

export function CaptureSection({ config, updateAndSave, chains }: CaptureSectionProps) {
  return (
    <>
      <div className={styles.sSection}>截图与栈</div>
      <ScreenshotRows config={config} updateAndSave={updateAndSave} chains={chains} />
      <StackRows config={config} updateAndSave={updateAndSave} />
    </>
  );
}
