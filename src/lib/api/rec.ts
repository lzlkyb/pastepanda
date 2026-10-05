/**
 * lib/api/rec.ts — 屏幕录制的 invoke 封装。
 *
 * 坐标约定与截图一致：全程**虚拟屏物理像素**；前端 CSS 坐标 × devicePixelRatio
 * + 虚拟屏原点（originX/originY）= 物理坐标。本窗覆盖整个虚拟屏，原点由
 * `recGetScreen()` 给出。
 */

export type RecQualityKey = "original" | "high" | "standard" | "smooth";

/** 虚拟屏物理几何（与 screenshot 的 ScreenInfo 同源口径）。 */
export interface RecScreenInfo {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

export interface RecStartReq {
  /** 选区（虚拟屏物理像素）。 */
  x: number;
  y: number;
  w: number;
  h: number;
  quality: RecQualityKey;
  sysAudio: boolean;
  micAudio: boolean;
}

export interface RecStatus {
  recording: boolean;
  finalizing: boolean;
  path: string | null;
  elapsedMs: number;
  quality: RecQualityKey | null;
}

export interface RecDone {
  path: string;
  bytes: number;
  durationMs: number;
  frames: number;
}

/** 虚拟屏物理几何（后端从 GetSystemMetrics 直读）。 */
export function recGetScreen(): Promise<RecScreenInfo> {
  return invokeJson("rec_virtual_screen");
}

/**
 * Tauri 命令按**形参名**包裹：`rec_start(req: RecStartReq)` 必须传 `{ req: {...} }`，
 * `rename_all = "camelCase"` 只作用于结构体内部字段（sysAudio/micAudio），不改变包裹层。
 */
export function recStart(req: RecStartReq): Promise<void> {
  return invokeVoid("rec_start", {
    req: {
      x: req.x,
      y: req.y,
      w: req.w,
      h: req.h,
      quality: req.quality,
      sysAudio: req.sysAudio,
      micAudio: req.micAudio,
    },
  });
}

export function recStop(discard = false): Promise<void> {
  return invokeVoid("rec_stop", { discard });
}

export function recStatus(): Promise<RecStatus> {
  return invokeJson("rec_status");
}

export function recReady(): Promise<void> {
  return invokeVoid("rec_ready");
}

export function recCloseWindows(): Promise<void> {
  return invokeVoid("rec_close_windows");
}

/* ── 内部：统一错误文案 ── */

import { invoke } from "@tauri-apps/api/core";

async function invokeVoid(cmd: string, args?: Record<string, unknown>): Promise<void> {
  try {
    await invoke(cmd, args);
  } catch (e) {
    throw new Error(errText(e));
  }
}

async function invokeJson<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(errText(e));
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
