import React from "react";
import { HelpTooltip } from "@/components/HelpTooltip";
import styles from "../Settings.module.css";

/** 设置图标语义色相（theme.css --ic-*）；缺省 brand 与 AI/品牌同源 */
export type IconHue =
  | "system" | "capture" | "save" | "editor"
  | "privacy" | "sync" | "paste" | "brand";

export const iconHueClass: Record<IconHue, string> = {
  system: "icSystem",
  capture: "icCapture",
  save: "icSave",
  editor: "icEditor",
  privacy: "icPrivacy",
  sync: "icSync",
  paste: "icPaste",
  brand: "icBrand",
};

/** sRowIcon + 语义色相，调用点一行搞定 */
export function hueIconClass(hue: IconHue = "brand"): string {
  return `${styles.sRowIcon} ${styles[iconHueClass[hue]]}`;
}

/** 彩砖 + 白圆盘 + emoji（最终稿）。圆盘是真实子节点，不用 ::before。 */
export function SettingTile({ hue = "brand", children }: {
  hue?: IconHue; children: React.ReactNode;
}) {
  return (
    <span className={hueIconClass(hue)}>
      <span className={styles.sRowIconGlyph}>{children}</span>
    </span>
  );
}

export function ToggleRow({ icon, hue = "brand", label, desc, value, onChange, tooltip, detailTitle, detail, recommend }: {
  icon: React.ReactNode; hue?: IconHue; label: string; desc: string; value: boolean; onChange: (v: boolean) => void;
  tooltip?: string; detailTitle?: string; detail?: React.ReactNode; recommend?: boolean;
}) {
  return (
    <div className={styles.sRow} onClick={() => onChange(!value)} style={{ cursor: "pointer" }}>
      <SettingTile hue={hue}>{icon}</SettingTile>
      <div className={`${styles.sRowBody}`}>
        <div className={`${styles.sRowLabel}`}>
          {label}
          {recommend && <span className={`${styles.sRowRecommend}`}>⭐推荐</span>}
          {(tooltip || detail) && (
            <HelpTooltip tooltip={tooltip} detailTitle={detailTitle} detail={detail} />
          )}
        </div>
        <div className={`${styles.sRowDesc}`}>{desc}</div>
      </div>
      <button className={`${styles.sToggle} ${value ? styles.on : styles.off}`}
        onClick={(e) => { e.stopPropagation(); onChange(!value); }}>
        <span className={styles.sToggleThumb} />
        <span className={styles.sToggleLabel}>{value ? "开" : "关"}</span>
      </button>
    </div>
  );
}
