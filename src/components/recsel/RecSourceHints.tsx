/**
 * RecSourceHints — 覆盖层里两条**跟着选区走**的小玻璃条（规则 7 从主件拆出）。
 * 纯展示：坐标由调用方给的 rect 推，不含状态与 IO。
 *
 * 2026-10-10 上线前审查 P2 的落点：确认态的尺寸不再重复报第二个数（L5），只留
 * 「按什么来源录制」；开录失败那句先说「发生了什么 + 下一步」，后端原文收进 title。
 */
import type { Rect } from "./snap";
import type { Phase } from "@/hooks/useRecSelectMouse";
import styles from "./RecOffice.module.css";

/** 拖拽/确认态选区上方的来源提示（拖拽态额外带实时裸尺寸）。 */
export function SizeHintBar({
  phase,
  rect,
  dpr,
  snapRect,
  rectFromWindow,
}: {
  phase: Phase;
  rect: Rect;
  dpr: number;
  snapRect: Rect | null;
  rectFromWindow: boolean;
}) {
  return (
    <div
      className="rec-glass"
      style={{ left: rect.x, top: Math.max(8, rect.y - 40) }} /* ui-rule-ok: 动态定位（跟随选区），同 recsel 既有模式 */
    >
      {phase === "dragging" && (
        <>
          <span>
            {Math.round(rect.w * dpr)}×{Math.round(rect.h * dpr)}
          </span>
          <span className="muted">
            {snapRect ? "松手保留自选区域" : "松手保留自选区域 · Esc 重选"}
          </span>
        </>
      )}
      {phase === "confirm" && (
        <span className="muted">
          {rectFromWindow
            ? "按当前位置录制；移动或遮挡窗口会改变录到的内容 · Esc 重选"
            : "点「重画」重新框选 · Esc 重选"}
        </span>
      )}
    </div>
  );
}

/** 启动失败条（非阻断；重试 / 重画 / Esc 全部可用，规则 15.3 不静默）。 */
export function StartErrBar({ message }: { rect: Rect; message: string }) {
  return (
    <div
      className={`rec-glass ${styles.audioError}`}
      role="alert"
      title={message}
    >
      <span className="rec-err">⚠ 没能开始录制</span>
      <span className="muted">{message} · 点「开始录制」重试 · Esc 重选</span>
    </div>
  );
}
