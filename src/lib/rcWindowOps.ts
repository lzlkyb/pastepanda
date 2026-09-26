/**
 * RC 窗口三键 / 拖拽 / 自适应的唯一出口（方案A，2026-09-25）。
 *
 * 为什么全走 Rust 自定义命令（rc_window_* / rc_fit_window_to_video）：
 * per-window ACL 是本窗一整类静默故障的来源——2026-09-18「点 X 毫无反应」
 * 前科（useRcWorkbenchClose 文件头 🔴），2026-09-25 用户再报「最小化 / 拖动
 * 没反应」。自定义命令不经 per-window ACL，失败以 String 返回，这里统一
 * 上抛给 toast（U3.5：catch 不许静默）。设计稿：design/远程电脑-会话窗壳
 * A方案-自适应窗口与可靠三键-设计稿.html §2/§6。
 *
 * 浏览器直开 rc.html 看版式（无 `__TAURI_INTERNALS__`）：保持哑、只记日志，
 * 不弹 toast——与旧 runWin 行为一致，不打扰版式预览。
 */
import { invoke } from "@tauri-apps/api/core";
import { logger } from "@/lib/logger";

type Notify = (msg: string, kind: "error") => void;

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 失败文案取 String：Rust 命令的 Err 本就是人话（「最小化窗口被拒绝：…」）。 */
function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

async function runOp(cmd: string, notify?: Notify): Promise<boolean> {
  if (!inTauri()) return false;
  try {
    await invoke(cmd);
    return true;
  } catch (e) {
    logger.warn(`窗口操作失败 ${cmd}`, e);
    notify?.(`窗口操作失败：${errText(e)}`, "error");
    return false;
  }
}

export function rcWindowMinimize(notify?: Notify): Promise<boolean> {
  return runOp("rc_window_minimize", notify);
}

export function rcWindowToggleMaximize(notify?: Notify): Promise<boolean> {
  return runOp("rc_window_toggle_maximize", notify);
}

/** 关闭仍触发 CloseRequested：「有会话先确认」守卫链不变。 */
export function rcWindowClose(notify?: Notify): Promise<boolean> {
  return runOp("rc_window_close", notify);
}

/** 会话窗按对方画面比例自适应。false = 跳过（最大化中，静默不打扰）。 */
export async function rcFitWindowToVideo(
  videoW: number,
  videoH: number,
  notify?: Notify,
): Promise<boolean> {
  if (!inTauri()) return false;
  try {
    await invoke("rc_fit_window_to_video", { videoW, videoH });
    return true;
  } catch (e) {
    logger.warn("画面自适应窗口失败", e);
    notify?.(`画面自适应窗口失败：${errText(e)}`, "error");
    return false;
  }
}
