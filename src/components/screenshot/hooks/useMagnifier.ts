/**
 * 放大镜 + 取色（select 态拖选时跟随光标）。
 *
 * 从 ScreenshotOverlay 抽出来的第一块逻辑（claude.md §7 行数上限）。选它先做是因为它
 * 耦合最浅：**零 useState**，全部状态都在 ref 里，外部只需要 dpr 与底图。
 * 纯搬运，行为未变。
 */

import { useCallback, useRef, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { logger } from "@/lib/logger";
import { samplePixelHex } from "@/lib/screenshot/pixelProbe";

/* 放大镜参数（物理像素）：采样半径 30px，4 倍放大 → 240×240 画布 */
const MAG_R = 30;
const MAG_ZOOM = 4;
/** 放大镜画布边长（物理像素）。JSX 要用它设 canvas 的 width/height，所以导出。 */
export const MAG_SIZE = MAG_R * 2 * MAG_ZOOM;

export function useMagnifier(params: {
  /** window.devicePixelRatio || 1 */
  dpr: number;
  /** 已加载的底图（马赛克采样 / 合成 / 放大镜共用同一份） */
  baseImgRef: RefObject<HTMLImageElement | null>;
}) {
  const { dpr, baseImgRef } = params;

  const magRef = useRef<HTMLDivElement | null>(null);
  const magCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const magInfoRef = useRef<HTMLSpanElement | null>(null);
  /** 当前是否可见。只写不读 —— 搬运时如实保留，是否要删由调用方决定。 */
  const magVisibleRef = useRef(false);
  const magHexRef = useRef("#000000");

  const updateMag = useCallback(
    (px: number, py: number) => {
      const base = baseImgRef.current;
      const magEl = magRef.current;
      const magCv = magCanvasRef.current;
      if (!base || !magEl || !magCv) return;
      const ctx = magCv.getContext("2d");
      if (!ctx) return;
      const sx = Math.max(0, Math.min(base.naturalWidth - MAG_R * 2, px - MAG_R));
      const sy = Math.max(0, Math.min(base.naturalHeight - MAG_R * 2, py - MAG_R));
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, magCv.width, magCv.height);
      ctx.drawImage(base, sx, sy, MAG_R * 2, MAG_R * 2, 0, 0, MAG_SIZE, MAG_SIZE);
      // 十字准星
      ctx.strokeStyle = "rgba(255,255,255,0.75)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(MAG_SIZE / 2, 0);
      ctx.lineTo(MAG_SIZE / 2, MAG_SIZE);
      ctx.moveTo(0, MAG_SIZE / 2);
      ctx.lineTo(MAG_SIZE, MAG_SIZE / 2);
      ctx.stroke();
      // 中心像素颜色。采样收口到 lib/screenshot/pixelProbe —— 吸管（annotate 态）走的是
      // 同一个实现，否则同一个像素两个入口会给出不同的字符串（曾经就是：这里小写、吸管大写）。
      const px1 = samplePixelHex(base, px, py);
      if (px1) {
        magHexRef.current = px1.hex;
        if (magInfoRef.current) {
          magInfoRef.current.innerHTML =
            `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;` +
            `background:${px1.hex};vertical-align:-1px;margin-right:5px"></span>` +
            `RGB(${px1.r}, ${px1.g}, ${px1.b}) · <span class="hex">${px1.hex}</span> · 点击复制`;
        }
      }
      // 定位（光标右上，越界翻转）
      const cssSize = MAG_SIZE / dpr;
      let left = px / dpr + 18;
      let top = py / dpr - cssSize - 10;
      if (left + cssSize + 10 > window.innerWidth) left = px / dpr - cssSize - 18;
      if (top < 10) top = py / dpr + 18;
      magEl.style.left = `${left}px`;
      magEl.style.top = `${top}px`;
      magEl.style.display = "flex";
      magVisibleRef.current = true;
    },
    [dpr, baseImgRef],
  );

  const hideMag = useCallback(() => {
    magVisibleRef.current = false;
    if (magRef.current) magRef.current.style.display = "none";
  }, []);

  const copyHex = useCallback(async () => {
    try {
      await invoke("copy_only", { text: magHexRef.current });
      if (magInfoRef.current) {
        magInfoRef.current.innerHTML = `<span class="hex">已复制 ${magHexRef.current}</span>`;
      }
    } catch (e) {
      logger.error("复制颜色失败", e);
    }
  }, []);

  return { magRef, magCanvasRef, magInfoRef, updateMag, hideMag, copyHex };
}
