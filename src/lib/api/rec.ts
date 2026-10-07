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
  /** true = 暂停中（不录内容、控制条计时冻结）。 */
  paused: boolean;
  path: string | null;
  elapsedMs: number;
  /** 已写入的媒体字节（视频+音频裸流；控制条体积显示，暂停冻结）。 */
  bytes: number;
  quality: RecQualityKey | null;
}

export interface RecDone {
  path: string;
  bytes: number;
  durationMs: number;
  frames: number;
  /** 中途故障落盘的部分保存（锁屏/分辨率变化等）：主窗 toast 附注说明。正常完成为 null。 */
  note?: string | null;
  /** true = 主窗隐藏，消息由 HUD 轻浮窗承接（双通路互斥，主窗 toast 据此闭嘴）。 */
  hud?: boolean;
}

/** 「最近录制」条目（后端 rec_list_files 扫保存目录）。 */
export interface RecFileMeta {
  name: string;
  path: string;
  bytes: number;
  durationMs: number | null;
}

/** 重录上次区域的计划（rec_take_rerecord 一次性消费；虚拟屏物理像素）。 */
export interface RecRerecordPlan {
  x: number;
  y: number;
  w: number;
  h: number;
  quality: RecQualityKey;
  sysAudio: boolean;
  micAudio: boolean;
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

/** 暂停/继续（控制条按钮）。幂等；收尾中后端拒绝。 */
export function recSetPaused(paused: boolean): Promise<void> {
  return invokeVoid("rec_pause", { paused });
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

/** 重录上次区域：沿用上次区域与参数，跳过框选直入倒计时。 */
export function recRerecord(): Promise<void> {
  return invokeVoid("rec_rerecord");
}

/** 选区窗挂载后取重录计划（仅 URL 带 mode=rerecord 的窗会拿到非 null）。 */
export function recTakeRerecord(): Promise<RecRerecordPlan | null> {
  return invokeJson("rec_take_rerecord");
}

/** HUD 窗挂载后取通知数据（一次性消费）。 */
export function recHudTake(): Promise<RecHudData | null> {
  return invokeJson("rec_hud_take");
}

/** HUD 通知载荷（后端组装；rec-hud-main 消费）。 */
export interface RecHudData {
  ok: boolean;
  path?: string;
  bytes?: number;
  durationMs?: number;
  quality?: string;
  note?: string | null;
  message?: string;
}

/** 「最近录制」列表（保存目录最近 5 条）。 */
export function recListFiles(): Promise<RecFileMeta[]> {
  return invokeJson("rec_list_files");
}

/** 删除一个录制文件（后端做保存目录 + 文件名白名单校验）。 */
export function recDeleteFile(path: string): Promise<void> {
  return invokeVoid("rec_delete_file", { path });
}

/** 资源管理器定位录屏产物。 */
export function recReveal(path: string): Promise<void> {
  return invokeVoid("rec_reveal", { path });
}

/** 用系统播放器打开录屏产物。 */
export function recOpenFile(path: string): Promise<void> {
  return invokeVoid("rec_open_file", { path });
}

/* ── 预览裁剪（四期 1.4；关键帧对齐无损剪切）── */

/** 视频轨关键帧索引（播放域毫秒；预览窗时间轴的吸附刻度）。 */
export interface RecKeyframeIndex {
  durationMs: number;
  keyframesMs: number[];
}

/** 预览窗数据（rec_preview_take 一次性消费）。 */
export interface RecPreviewData {
  path: string;
  name: string;
  bytes: number;
}

/** 裁剪结果（inMs/outMs 是吸附后的实际值，可能比用户选段略大——宁多勿少）。 */
export interface RecTrimResult {
  path: string;
  bytes: number;
  inMs: number;
  outMs: number;
}

export function recKeyframes(path: string): Promise<RecKeyframeIndex> {
  return invokeJson("rec_keyframes", { path });
}

/** 关键帧对齐无损剪切：产物落新文件（原名 + _剪），原文件不动。 */
export function recTrim(path: string, inMs: number, outMs: number): Promise<RecTrimResult> {
  return invokeJson("rec_trim", { path, inMs, outMs });
}

/** 打开预览裁剪窗（HUD「✂ 预览」/ 最近录制行尾 ✂ 共用入口）。 */
export function recOpenPreview(path: string): Promise<void> {
  return invokeVoid("rec_open_preview", { path });
}

/** 预览窗挂载后取数据（一次性消费；null = 已被重开的窗取走）。 */
export function recPreviewTake(): Promise<RecPreviewData | null> {
  return invokeJson("rec_preview_take");
}

/* ── GIF 导出（四期 1.5；12fps / 宽 ≤480 / 循环，单任务串行可取消）── */

export interface RecGifStatus {
  running: boolean;
  /** 0–99；完成态以 running=false + donePath 表达。 */
  percent: number;
  donePath: string | null;
  error: string | null;
}

/** 启动导出（产物 = 同名 .gif，重复导出覆盖自己；原 mp4 不动）。 */
export function recGifStart(path: string): Promise<void> {
  return invokeVoid("rec_gif_start", { path });
}

export function recGifStatus(path: string): Promise<RecGifStatus> {
  return invokeJson("rec_gif_status", { path });
}

export function recGifCancel(): Promise<void> {
  return invokeVoid("rec_gif_cancel");
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
