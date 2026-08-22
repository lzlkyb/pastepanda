/**
 * 粘贴引擎 API — 底层粘贴/复制/窗口操作
 */
import { invoke } from "@tauri-apps/api/core";
import { logger } from "@/lib/logger";
import { toastActionFailed } from "@/lib/utils";
import { maskSensitiveText } from "@/lib/mask";
import { useDialogStore } from "@/stores/dialogStore";

/** 目标应用可读名（守卫确认条的提示文案） */
function targetAppLabel(category: TargetCategory | null, app: string | null): string | null {
  if (app) return app;
  if (!category) return null;
  const map: Record<string, string> = {
    browser: "浏览器",
    excel: "Excel",
    word: "Word",
    office: "WPS 办公",
    ide: "代码编辑器",
    terminal: "终端",
    other: "其他应用",
  };
  return map[category] ?? null;
}

/**
 * 粘贴守卫（v6.2 下沉到 API 层，审查 #8）：
 * 所有用户触发的粘贴（卡片/托盘/快捷区/链/序列/编辑器…）都走这里——
 * 敏感内容先弹确认条（[脱敏后粘贴]/[原样粘贴]/[取消]），不再依赖各调用点手动包裹。
 * 内容不敏感 → 直接粘贴（本地检测零 IPC 开销）。
 */
export async function pasteTextGuarded(text: string): Promise<boolean> {
  const trimmed = (text || "").trim();
  if (!trimmed) return false;

  const { text: masked, count } = maskSensitiveText(trimmed);
  if (count > 0 && masked !== trimmed) {
    const check = await pastePrecheck();
    const decision = await new Promise<"mask" | "raw" | "cancel">((resolve) => {
      useDialogStore.getState().openPasteGuard({
        text: trimmed,
        maskPreview: masked,
        targetApp: targetAppLabel(check.targetCategory, check.targetApp),
        resolve,
      });
    });
    useDialogStore.getState().closePasteGuard();
    if (decision === "cancel") return false;
    return decision === "mask" ? pasteText(masked) : pasteText(trimmed);
  }
  return pasteText(trimmed);
}

/** 富文本粘贴同样走敏感闸（按纯文本检测；脱敏后连富文本一起换掉） */
export async function pasteRichGuarded(html: string, text: string): Promise<boolean> {
  const trimmed = (text || "").trim();
  const { text: masked, count } = maskSensitiveText(trimmed);
  if (count > 0 && masked !== trimmed) {
    const check = await pastePrecheck();
    const decision = await new Promise<"mask" | "raw" | "cancel">((resolve) => {
      useDialogStore.getState().openPasteGuard({
        text: trimmed,
        maskPreview: masked,
        targetApp: targetAppLabel(check.targetCategory, check.targetApp),
        resolve,
      });
    });
    useDialogStore.getState().closePasteGuard();
    if (decision === "cancel") return false;
    return decision === "mask" ? pasteRich(masked, masked) : pasteRich(html, trimmed);
  }
  return pasteRich(html, trimmed);
}

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

/** 目标应用类别 */
export type TargetCategory = "browser" | "excel" | "word" | "office" | "ide" | "terminal" | "other";

/** 粘贴前检查（v6.2）：目标应用感知 */
export interface PastePrecheck {
  targetApp: string | null;
  targetCategory: TargetCategory | null;
}

/** 查询粘贴目标应用（Rust 侧读前台窗口进程名） */
export async function pastePrecheck(): Promise<PastePrecheck> {
  try {
    return await invoke<PastePrecheck>("paste_precheck");
  } catch {
    return { targetApp: null, targetCategory: null };
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

/**
 * 粘贴图文混排内容（CF_HTML 富文本 + 纯文本保底一起写剪贴板），返回是否成功。
 * 目标应用不认富文本时自动退到纯文本，不会粘出空白。
 */
export async function pasteRich(htmlFragment: string, plainText: string): Promise<boolean> {
  try {
    await invoke("paste_rich", { htmlFragment, plainText });
    return true;
  } catch (e) {
    logger.error("图文粘贴失败", e);
    const msg = e instanceof Error ? e.message : String(e);
    window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `图文粘贴失败: ${msg}`, type: "error" } }));
    return false;
  }
}

/** 仅复制图文混排内容到剪贴板（不粘贴） */
export async function copyRichOnly(htmlFragment: string, plainText: string): Promise<void> {
  await invoke("copy_rich_only", { htmlFragment, plainText });
}

/**
 * 按条目类型复制到剪贴板 —— 所有“复制卡片”入口的唯一实现。
 *
 * 为什么抽成公共函数：这段分派逻辑曾在 Card.tsx 里被拷了三份（悬停复制按钮、
 * hover 预览卡片、右键菜单），新增图文混排类型时三处全漏了，结果图文内容
 * 复制出去只剩文字。以后再加类型只改这里一处。
 *
 * 返回给用户看的提示文案；失败直接抛，由调用方弹错误 toast。
 */
export async function copyItemToClipboard(item: {
  type: string;
  text: string;
  content?: string;
}): Promise<string> {
  if (item.type === "image" && item.content) {
    await copyImageOnly(item.content);
    return "已复制图片";
  }
  if (item.type === "file" && item.content) {
    await copyFiles([item.content]);
    return "已复制文件";
  }
  if ((item.type === "rich" || item.type === "doc") && item.content) {
    // 富文本 + 纯文本一起写，目标应用不认富文本时自动退到文字
    await copyRichOnly(item.content, item.text);
    return item.type === "doc" ? "已复制文档" : "已复制图文";
  }
  await navigator.clipboard.writeText(item.text || "");
  return "已复制";
}

/** 仅复制 */
export async function copyOnly(text: string) {
  try {
    await invoke("copy_only", { text });
  } catch (e) {
    logger.error("复制失败", e);
    toastActionFailed("复制", e);
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
