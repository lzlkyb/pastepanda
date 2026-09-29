/**
 * fileDetail.ts — 文件详情弹框的纯判断与类型（跨 FileDetailDialog / FilePreviewPanel /
 * FileSingleBody / FileMultiBody 共用）。
 *
 * 这里只放**纯函数与类型**：带 invoke / toast / clipboard 的动作在 `fileActions.ts`，
 * 需要环境的两半分开，纯判断才能无环境单测（规则 #11.1 的收口要求）。
 */
import { formatBytes } from "@/lib/utils";

// ===== 类型 =====

export interface FileMeta {
  size: number;
  exists: boolean;
}

export interface TextPreviewData {
  kind: "text" | "binary" | "missing";
  file_size: number;
  total_lines: number;
  lines: string[];
  truncated: boolean;
  extension: string;
}

// ===== 扩展名族 =====

const IMAGE_EXT_SET = new Set(["png", "jpg", "jpeg", "gif", "bmp", "webp", "ico", "svg"]);
/** PDF：走 PdfViewer 内嵌阅读预览（pdfjs-dist），不请求后端文本预览 */
const PDF_EXT = "pdf";

/** 媒体预览（Tier2）：file 类型音视频内嵌播放，走 Tauri asset 协议。
 *
 *  只列 WebView 原生能解的容器 —— mov / mkv / avi / wmv / flv / wma 一律降级走
 *  「用系统打开」。之前把它们也列进来但又被播放门槛挡在外面，是一份不起作用的死名单。
 *  这两个集合与 Rust 侧 `ALLOWED_MEDIA_EXTENSIONS`（asset 授权白名单）一一对应，改一处要同步另一处。 */
const VIDEO_EXT_SET = new Set(["mp4", "webm", "ogv", "m4v"]);
const AUDIO_EXT_SET = new Set(["mp3", "wav", "ogg", "m4a", "flac", "aac"]);

export function extOf(p: string): string {
  const m = p.match(/\.([^.\\/]*)$/);
  return (m?.[1] || "").toLowerCase();
}

export function isImageFile(p: string): boolean {
  return IMAGE_EXT_SET.has(extOf(p));
}

export function isPdfFile(p: string): boolean {
  return extOf(p) === PDF_EXT;
}

export function isVideoFile(p: string): boolean {
  return VIDEO_EXT_SET.has(extOf(p));
}

export function isAudioFile(p: string): boolean {
  return AUDIO_EXT_SET.has(extOf(p));
}

export function isPlayableMedia(p: string): boolean {
  return isVideoFile(p) || isAudioFile(p);
}

/** 文本文件 → 全屏编辑器 contentType 映射（与 FullscreenEditor 注册表对齐） */
const TEXT_CONTENT_TYPE: Record<string, string> = {
  md: "markdown", markdown: "markdown", json: "json",
  html: "html", htm: "html", csv: "csv", tsv: "csv", log: "log", txt: "text",
  js: "code", ts: "code", tsx: "code", jsx: "code", py: "code", rs: "code",
  go: "code", java: "code", c: "code", cpp: "code", sh: "shell", yml: "code",
  yaml: "code", xml: "code", css: "code", sql: "code",
};

export function textContentType(ext: string): string {
  return TEXT_CONTENT_TYPE[ext] || "text";
}

// ===== 展示辅助 =====

/** 文件大小 → `1.5 MB`。**收口到 `lib/utils.ts` 的 `formatBytes`**（规则 #11 单一数据源）：
 *  本文件此前自带一份 `formatSize`，把「空文件」显示成「未知」——0 字节是合法大小。 */
export { formatBytes as formatSize };

export function nameOf(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

/** 所在目录（不含末尾分隔符）；没有分隔符（裸文件名）返回 ""。 */
export function dirOf(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(0, idx) : "";
}

// ===== 「打开全部文件夹」的纯规划 =====

export interface OpenAllPlan {
  /** 每个目录一个**代表路径**（保持 paths 顺序，同目录只留第一个） */
  paths: string[];
  /** true = 没有可打开的目标（调用方应给出「没有可打开的文件」提示） */
  empty: boolean;
}

/** 从可打开路径中挑出「每个目录第一个」的代表路径。
 *
 *  - `isOpenable` 由调用方给（本组件口径：`info.exists` 或「查失败」——后者不是
 *    「确认不存在」，一并包进来，真开不成计入 failedTotal）；
 *  - 同一目录只开一次（多个文件同目录 = 一个资源管理器窗口）；
 *  - 顺序保持 paths 原序，用户列表里的先后就是窗口弹出的先后；
 *  - ❗ 直接产出代表路径而不是只给目录名：调用方若拿目录名反查路径
 *    （`startsWith(dir)`），`C:\data` 会字符串前缀命中 `C:\data2\a.txt`，
 *    排前面就先被选中——结果第二个目录永远不开、第一个开两次。 */
export function planOpenAllFolders(paths: string[], isOpenable: (p: string) => boolean): OpenAllPlan {
  const picked: string[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    if (!isOpenable(p)) continue;
    // 裸文件名没有目录：key 用它自己。若塌成 "" 所有裸文件名会只留第一个，
    // 其余被静默丢掉（旧实现按文件名本身建 key，行为一致）。
    const dir = dirOf(p);
    const key = dir === "" ? p : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(p);
  }
  return { paths: picked, empty: picked.length === 0 };
}

/** 连续失败几次就中止批量打开（系统级故障短路，别再白试 N 次）。 */
export const OPEN_ALL_MAX_STREAK = 3;
export function openAllShouldAbort(streak: number): boolean {
  return streak >= OPEN_ALL_MAX_STREAK;
}

export interface OpenAllSummary {
  message: string;
  level: "success" | "error" | "info";
}

/** 批量打开的汇总口径（三分支，与旧实现逐字对齐）。
 *
 *  `lastErrText`：**全失败**时透出真实原因（「文件不存在」vs「权限不足」不是一回事）。
 *  旧实现在这一支弹 `errText(lastErr, "无法打开文件夹")`，抽函数时差点把它写成死文案。 */
export function summarizeOpenAll(opened: number, failedTotal: number, aborted: boolean, lastErrText?: string): OpenAllSummary {
  if (failedTotal === 0) return { message: `已打开 ${opened} 个文件夹`, level: "success" };
  if (opened === 0) return { message: lastErrText || "无法打开文件夹", level: "error" };
  return {
    message: `已打开 ${opened} 个文件夹，${failedTotal} 个失败${aborted ? "（连续失败已中止）" : ""}`,
    level: "info",
  };
}
