/**
 * RcGroupRow — 折叠组里的一行设置（真 `sRow` 结构，和设置页其余分区同款）。
 *
 * 为什么每行都改成 `sRow` 而不是继续用 `lanPanel` 里的大块：
 * `useSettingsSearch` 的 `rowLabel()` 只认 `.sRowLabel`、`highlightSearchKw()` 只往
 * `.sRowLabel/.sRowDesc` 注底纹。原来的整块面板在搜索眼里只是**一个** child，
 * 于是「命中 1 项但零底纹、只滚到整块顶部」。改成行之后一并修好（设计稿 §2 第 2 条）。
 *
 * `children` 是右控件列。🔴 它很窄：420px 内容列 − 32 内边距 − 40 彩砖 − 2×12 间隙
 * − label/desc 实占 189–213 ⇒ 只剩 72–96px（设计稿 §2 现场量的）。所以 ≥3 档的
 * 选择一律走 `RcDropdown`，两档才用 `sSegGroup`。
 */
import type { ReactNode } from "react";
import { HelpTooltip } from "@/components/HelpTooltip";
import { SettingTile, type IconHue } from "../ToggleRow";
import shared from "../../Settings.module.css";
import styles from "../RcSettings.module.css";

export function RcGroupRow({
  hue,
  icon,
  label,
  desc,
  detailTitle,
  detail,
  off,
  children,
}: {
  hue: IconHue;
  icon: string;
  label: string;
  desc: ReactNode;
  detailTitle?: string;
  detail?: ReactNode;
  /** 这行配的是「被控」上限、此刻通道没开：整行变灰。**禁用交给控件自己的 `disabled`**——
   * `.rcGated` 的 `pointer-events:none` 会连 `?` 说明一起挡掉，而这俩类本来的分工就是
   * 「变灰」与「禁交互」分开（见 `RcSettings.module.css` 顶部注释）。 */
  off?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`${shared.sRow}${off ? ` ${styles.rcPanelOff}` : ""}`}>
      <SettingTile hue={hue}>{icon}</SettingTile>
      <div className={shared.sRowBody}>
        <div className={shared.sRowLabel}>
          {label}
          {detail && <HelpTooltip detailTitle={detailTitle} detail={detail} />}
        </div>
        <div className={shared.sRowDesc}>{desc}</div>
      </div>
      {children}
    </div>
  );
}
