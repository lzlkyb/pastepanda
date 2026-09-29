/**
 * fileActions.ts — 文件详情弹框的 IO 动作（单一数据源，规则 #11.1）。
 *
 * 「打开 / 定位 / 复制路径」原先在三个组件里各写了一份：单文件壳、预览面板、多文件
 * 列表行——三份 try/catch + toast，改文案要同步三处、漏一处就口径漂移（用户看到
 * 「已打开」与「无法打开」在不同层级说法不一）。现全部收口到这里。
 *
 * ❗ toast 由调用方注入（`useToast()` 是 React context hook，本模块不是组件、拿不到）。
 * ❗ 失败路径自己弹 toast（规则 #15.3）：三个调用点都在弹框内，静默 setState 在折叠态
 *    下等于没反馈。忙碌态（哪个文件正在开）仍归调用方——那是界面状态。
 */
import { invoke } from "@tauri-apps/api/core";
import type { ToastFn } from "@/components/Toast";
import { errText } from "@/lib/utils";
import {
  type FileMeta,
  type TextPreviewData,
  nameOf,
  openAllShouldAbort,
  planOpenAllFolders,
  summarizeOpenAll,
} from "@/lib/fileDetail";

/** 用系统默认程序打开文件。返回 false = 失败（toast 已出）。 */
export async function openFileWithSystem(path: string, toast: ToastFn): Promise<boolean> {
  try {
    await invoke("open_file_with_system", { path });
    toast(`已打开 ${nameOf(path)}`, "success");
    return true;
  } catch (e) {
    toast(errText(e, "无法打开文件"), "error");
    return false;
  }
}

/** 在资源管理器中定位文件。返回 false = 失败（toast 已出）。 */
export async function revealInFolder(path: string, toast: ToastFn): Promise<boolean> {
  try {
    await invoke("open_file_location", { path });
    return true;
  } catch (e) {
    toast(errText(e, "无法打开文件夹"), "error");
    return false;
  }
}

/** 复制单个路径到剪贴板。 */
export async function copyPath(path: string, toast: ToastFn): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(path);
    toast("路径已复制", "success");
    return true;
  } catch {
    toast("复制失败", "error");
    return false;
  }
}

/** 复制全部路径（换行拼接）。 */
export async function copyAllPaths(paths: string[], toast: ToastFn): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(paths.join("\n"));
    toast(`已复制 ${paths.length} 个路径`, "success");
    return true;
  } catch {
    toast("复制失败", "error");
    return false;
  }
}

/** 读取单个文件的元信息（存在性 + 大小）。失败抛错由调用方按 U3.5 口径分流：
 *  「没查到」≠「不存在」，不能把查询失败渲染成对用户文件的肯定断言。 */
export async function getFileMeta(path: string): Promise<FileMeta> {
  return invoke<FileMeta>("get_file_info", { path });
}

export interface OpenAllResult {
  opened: number;
  failedTotal: number;
  aborted: boolean;
}

/** 打开全部文件夹：按目录去重、逐个开、连续 3 次失败短路。
 *
 *  try 收进循环体（旧实现曾把整个循环包在一个 try 里）：第 3 个失败就中断的话，
 *  前 2 个已经真的开出了资源管理器窗口，提示却只说「无法打开文件夹」——屏幕上凭空
 *  多出两个窗口，而提示说的是没打开。 */
export async function openAllFolders(
  paths: string[],
  isOpenable: (p: string) => boolean,
  toast: ToastFn,
): Promise<OpenAllResult> {
  const plan = planOpenAllFolders(paths, isOpenable);
  if (plan.empty) {
    toast("没有可打开的文件", "error");
    return { opened: 0, failedTotal: 0, aborted: false };
  }
  let opened = 0;
  let failedTotal = 0;
  let streak = 0;
  let aborted = false;
  let lastErr: unknown = null;
  for (const path of plan.paths) {
    try {
      await invoke("open_file_location", { path });
      opened++;
      streak = 0;
    } catch (e) {
      lastErr = e;
      failedTotal++;
      streak++;
      // 连续 3 次失败多半是系统级故障（资源管理器挂了），再跑下去只会白试 N 次
      if (openAllShouldAbort(streak)) {
        aborted = true;
        break;
      }
    }
  }
  // 全失败时透出真实原因：一个笼统的「无法打开文件夹」让人分不清是文件没了还是权限不够
  const s = summarizeOpenAll(opened, failedTotal, aborted, lastErr ? errText(lastErr, "无法打开文件夹") : undefined);
  toast(s.message, s.level);
  return { opened, failedTotal, aborted };
}

/** 读取文本预览（前 N 行 + 元信息）。 */
export async function readTextPreview(path: string): Promise<TextPreviewData> {
  return invoke<TextPreviewData>("read_text_file_preview", { path });
}

/** 读取文件全文（复制全文用；预览只取前 N 行，复制必须拿全量）。 */
export async function readTextFull(path: string): Promise<string> {
  return invoke<string>("read_text_file_full", { path });
}

/** 把文件加进 tauri asset 白名单并返回规范化路径（音视频内嵌播放用）。 */
export async function allowMediaAsset(path: string): Promise<string> {
  return invoke<string>("allow_media_asset", { path });
}
