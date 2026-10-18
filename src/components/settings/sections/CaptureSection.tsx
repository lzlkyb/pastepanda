import type { AppConfig } from "@/stores/appStore";
import { ScreenshotRows } from "./ScreenshotRows";
import { RecRows, RecSectionTitle } from "./RecRows";
import type { SettingsData } from "@/hooks/useSettingsData";
import styles from "../../Settings.module.css";

interface CaptureSectionProps {
  config: AppConfig;
  updateAndSave: (partial: Record<string, unknown>) => Promise<boolean>;
  chains: SettingsData["chains"];
}

export function CaptureSection({ config, updateAndSave, chains }: CaptureSectionProps) {
  return (
    <>
      <div className={styles.sSection}>截图与录屏</div>
      <div data-settings-parent="截图与录屏" className={styles.sSection}>截图与文字识别</div>
      <ScreenshotRows config={config} updateAndSave={updateAndSave} chains={chains} />
      <RecSectionTitle />
      <RecRows config={config} updateAndSave={updateAndSave} />
    </>
  );
}
