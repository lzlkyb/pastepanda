/**
 * 粘贴引擎 API — 底层粘贴/复制/窗口操作
 */
import { invoke } from "@tauri-apps/api/core";
import { logger } from "@/lib/logger";

/** 粘贴文本，返回是否成功 */
export async function pasteText(text: string): Promise<boolean> {
  try {
    const result = await invoke<{ success: boolean; error?: string; target_hwnd: number | null; clipboard_written: boolean; wm_paste_sent: boolean } | null>("paste_text", { text });
    if (!result || !result.success) {
      window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `粘贴失败: ${result?.error || "未知"}`, type: "error" } }));
      return false;
    }
    return true;
  } catch (e) {
    logger.error("粘贴失败", e);
    const msg = e instanceof Error ? e.message : String(e);
    window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `粘贴失败: ${msg}`, type: "error" } }));
    return false;
  }
}

/** 粘贴图片，返回是否成功 */
export async function pasteImage(imagePath: string): Promise<boolean> {
  try {
    await invoke("paste_image", { imagePath });
    return true;
  } catch (e) {
    logger.error("图片粘贴失败", e);
    const msg = e instanceof Error ? e.message : String(e);
    window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `图片粘贴失败: ${msg}`, type: "error" } }));
    return false;
  }
}

/** 仅复制 */
export async function copyOnly(text: string) {
  try {
    await invoke("copy_only", { text });
  } catch (e) {
    logger.error("复制失败", e);
  }
}

/** 仅复制图片到剪贴板（走 Rust arboard，比 Web API 可靠） */
export async function copyImageOnly(imagePath: string): Promise<void> {
  await invoke("copy_image_only", { imagePath });
}

/** 复制文件到剪贴板（CF_HDROP，等同于资源管理器 Ctrl+C） */
export async function copyFiles(paths: string[]): Promise<void> {
  await invoke("copy_files", { paths });
}

/** 保存前台窗口句柄 */
export async function saveForeground() {
  try {
    await invoke("save_foreground");
  } catch (e) {
    logger.error("保存前台句柄失败", e);
  }
}

/** 切换窗口显示 */
export async function toggleWindow() {
  try {
    await invoke("toggle_window");
  } catch (e) {
    logger.error("切换窗口失败", e);
  }
}
