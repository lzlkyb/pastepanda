import React from "react";
import { HelpTooltip } from "@/components/HelpTooltip";
import styles from "../Settings.module.css";

export function ToggleRow({ icon, gradient, label, desc, value, onChange, tooltip, detailTitle, detail, recommend }: {
  icon: React.ReactNode; gradient: string; label: string; desc: string; value: boolean; onChange: (v: boolean) => void;
  tooltip?: string; detailTitle?: string; detail?: React.ReactNode; recommend?: boolean;
}) {
  return (
    <div className={styles.sRow} onClick={() => onChange(!value)} style={{ cursor: "pointer" }}>
      <span className={`${styles.sRowIcon}`} style={{ background: gradient }}>{icon}</span>
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
