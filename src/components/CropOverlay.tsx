/**
 * CropOverlay — 全屏查看层的裁剪交互层（遮罩 + 选区 + 手柄 + 确认栏）。
 *
 * 从 ImagePreviewDialog.tsx 提出（拆件守规则 #7 的 300 行红线）。裁剪态只在
 * `cropMode` 为真时出现，逻辑本身是纯 UI：几何来自 hook 的 `cropRect`，动作回传
 * 调用方（mousedown / 确认 / 取消 / 还原）。
 *
 * 手柄方位枚举（tl/tc/tr/ml/mr/bl/bc/br）必须逐个给定位与光标 —— 这是 CSS 写不出来的
 * 部分，运行期值只能内联（各行的豁免说明见下）。
 */
import { Check, RotateCcw } from "lucide-react";
import type { CropRect } from "@/hooks/useImagePreview";
import styles from "./CardList.module.css";

const HANDLES = ["tl", "tc", "tr", "ml", "mr", "bl", "bc", "br"] as const;

export function CropOverlay({ cropRect, cropOriginal, onMouseDown, onRestore }: {
  cropRect: CropRect | null;
  cropOriginal: string | null;
  onMouseDown: (e: React.MouseEvent) => void;
  onRestore: () => void;
}) {
  return (
    <>
      <div className={styles.cropBackdrop} onMouseDown={onMouseDown} style={{ cursor: "crosshair" }} />
      {cropRect && (
        <>
          <div className={styles.cropMask} style={{ top: 0, left: 0, right: 0, height: cropRect.y }} />
          <div className={styles.cropMask} style={{ bottom: 0, left: 0, right: 0, height: `calc(100% - ${cropRect.y + cropRect.h}px)` }} />
          <div className={styles.cropMask} style={{ top: cropRect.y, left: 0, width: cropRect.x, height: cropRect.h }} />
          <div className={styles.cropMask} style={{ top: cropRect.y, right: 0, width: `calc(100% - ${cropRect.x + cropRect.w}px)`, height: cropRect.h }} />
          <div className={styles.cropSel} style={{ left: cropRect.x, top: cropRect.y, width: cropRect.w, height: cropRect.h }}>
            <div className={styles.cropGridH} style={{ top: "33.333%" }} />
            <div className={styles.cropGridH} style={{ top: "66.667%" }} />
            <div className={styles.cropGridV} style={{ left: "33.333%" }} />
            <div className={styles.cropGridV} style={{ left: "66.667%" }} />
            {HANDLES.map((name) => (
              <div
                key={name}
                className={`${styles.cropHandle}${name.length === 2 && !name.includes("c") ? ` ${styles.cropHandleCorner}` : ""}`}
                /* ui-rule-ok: 手柄定位由手柄方位决定（运行期枚举），只能内联 */
                style={
                  name === "tl" ? { left: -5, top: -5, cursor: "nwse-resize" }
                  : name === "tc" ? { left: "50%", top: -5, cursor: "ns-resize", transform: "translateX(-50%)" }
                  : name === "tr" ? { right: -5, top: -5, cursor: "nesw-resize" }
                  : name === "ml" ? { left: "50%", top: "50%", cursor: "ew-resize", transform: "translateY(-50%)" }
                  : name === "mr" ? { right: -5, top: "50%", cursor: "ew-resize", transform: "translateY(-50%)" }
                  : name === "bl" ? { left: -5, bottom: -5, cursor: "nesw-resize" }
                  : name === "bc" ? { left: "50%", bottom: -5, cursor: "ns-resize", transform: "translateX(-50%)" }
                  : { right: -5, bottom: -5, cursor: "nwse-resize" }
                }
              />
            ))}
            <div className={styles.cropHintBar}><span>{Math.round(cropRect.w)} × {Math.round(cropRect.h)}</span></div>
          </div>
        </>
      )}
      {cropOriginal && (
        <button className={styles.fsRestoreBtn} onClick={(e) => { e.stopPropagation(); onRestore(); }} title="还原原图">
          <RotateCcw size={13} /> 还原原图
        </button>
      )}
    </>
  );
}

/** 裁剪确认栏：顶替底部工具栏的位置（主工具栏同时被压暗）。 */
export function CropConfirmBar({ cropRect, onConfirm, onCancel }: {
  cropRect: CropRect | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className={styles.fsCropBar}>
      <span>拖拽绘制选区 · 拖动手柄调整 · Enter 确认</span>
      <button
        className={`${styles.fsPanelBtn} ${styles.fsPanelBtnPri}`}
        onClick={onConfirm}
        disabled={!cropRect || cropRect.w < 10 || cropRect.h < 10}
      >
        <Check size={13} /> 确认裁剪
      </button>
      <button className={styles.fsPanelBtn} onClick={onCancel}>取消</button>
    </div>
  );
}
