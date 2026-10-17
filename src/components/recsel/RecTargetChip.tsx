/**
 * RecTargetChip — 录前条上的「将录制」读数胶囊（规则 7：从 RecOverlayParts 拆出）。
 *
 * 「读数即控制」是既有不变量（§17 纯鼠标可达）：目标是一扇窗时，**整枚胶囊**
 * 就是「放弃它、改录整屏」的按钮——默认主张（整屏）必须有一条鼠标路径，
 * 不能只靠 Esc 退出整层。读数本身只留尺寸：来源（整屏 / 窗口 / 自选区域）
 * 交给左侧图标，动作就是这枚胶囊自己（§5.1：这条读数 22 字 → 0 字）。
 *
 * 图标走 lucide（与 RecControlBar 同一套），不再手描 SVG——两处各画一遍必然走形。
 */
import { AppWindow, Crop, Monitor, type LucideIcon } from "lucide-react";

/** 目标来源：screen=整屏（默认主张）、window=悬停采纳的窗口、region=拖拽自选区域。 */
export type TargetKind = "screen" | "window" | "region";

const ICONS: Record<TargetKind, LucideIcon> = {
  screen: Monitor,
  window: AppWindow,
  region: Crop,
};

/** 只进 title / aria-label——视觉上不再出现「窗口所在区域」这六个字。 */
const NAMES: Record<TargetKind, string> = {
  screen: "整个屏幕",
  window: "窗口所在区域",
  region: "自选区域",
};

export function TargetChip({
  text,
  kind,
  onRelease,
}: {
  /** 已对齐到物理偶数像素的尺寸读数，如 `1536 × 1100`。 */
  text: string;
  kind: TargetKind;
  /** 只在「有一个窗口目标可放弃」时给出口；整屏态不给死控件。 */
  onRelease?: () => void;
}) {
  const Icon = ICONS[kind];
  const hint = `将录制${NAMES[kind]} ${text}`;
  const inner = (
    <>
      <Icon size={13} aria-hidden="true" />
      <span className="rec-target-v">{text}</span>
    </>
  );
  if (!onRelease) {
    return (
      <span className="rec-target-chip static" title={hint}>
        {inner}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="rec-target-chip"
      onClick={onRelease}
      title={`${hint}；点这里改录整个屏幕`}
      aria-label={`${hint}；点这里改录整个屏幕`}
    >
      {inner}
    </button>
  );
}
