/**
 * `createJpegSink` — JPEG 帧上屏（整帧覆盖 / 脏块贴块）。
 *
 * 从 `hooks/useRcFrames.ts` 拆出（2026-09-22）：那个 hook 已经顶到 400 行红线，
 * 而这块是纯「帧 → canvas」的绘图编排，与取帧循环、统计、H.264 解码器生命周期
 * 互不相干，是最好切的一刀。
 *
 * 两条不变量（原来写在 hook 里，一并搬过来）：
 * - **宽高没变就不 setState**：高帧率下这是每帧路径，无谓的 setState 会让会话视图
 *   整树按帧率重渲染。
 * - **脏块帧缺基准画布不许静默丢**：丢一块就是花屏缺块。记一次 miss 并**限频**
 *   （1s/次）向被控端要关键帧，等 full / key 自愈。
 */
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { RcBinFrame } from "./api/rcFrameTypes";

/** 脏块 miss 后请求关键帧的最小间隔（ms）。 */
const KEY_REQ_MIN_GAP_MS = 1000;

export function createJpegSink(opts: {
  /** 会话是否还在：卸载后不再碰 canvas / state。 */
  alive: () => boolean;
  /** 画布内容几何（脏块帧的基准与画布尺寸都取自它）。 */
  content: MutableRefObject<{ w: number; h: number }>;
  /** 写画布几何（值不变时由内部保证不重复 setState）。 */
  setSize: Dispatch<SetStateAction<{ w: number; h: number }>>;
  /** 一帧真的上了屏（fps 计数 / hasFrame 置位）。 */
  onShown: () => void;
  /** 向被控端要一个强制关键帧。 */
  requestKey: () => void;
}): (f: RcBinFrame, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => Promise<void> {
  const { alive, content, setSize, onShown, requestKey } = opts;
  /** P1-10：脏块 miss 时 request_key 的限频（1s/次）。放 factory 里而不是调用方，
   *  因为它是这块逻辑的内部状态，调用方不该关心。 */
  let lastDirtyMissAt = 0;

  return async (f, canvas, ctx) => {
    const bmp = await createImageBitmap(new Blob([f.data], { type: "image/jpeg" }));
    try {
      if (!alive()) return;
      if (f.full || !f.rect) {
        const w = f.width || bmp.width;
        const h = f.height || bmp.height;
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        content.current = { w, h };
        // 宽高没变就不 setState：fps120 下这是每帧路径，无谓的 setState
        // 会让会话视图整树按帧率重渲染
        setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
        ctx.drawImage(bmp, 0, 0);
      } else {
        if (content.current.w === 0) {
          const now = Date.now();
          if (now - lastDirtyMissAt > KEY_REQ_MIN_GAP_MS) {
            lastDirtyMissAt = now;
            requestKey();
          }
          return;
        }
        if (canvas.width !== content.current.w) {
          canvas.width = content.current.w;
          canvas.height = content.current.h;
        }
        const r = f.rect;
        ctx.drawImage(bmp, r.x, r.y);
      }
      onShown();
    } finally {
      bmp.close();
    }
  };
}
