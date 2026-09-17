/**
 * 粘贴引擎 API — 底层粘贴/复制/窗口操作
 */
import { invoke } from "@tauri-apps/api/core";
import { logger } from "@/lib/logger";
import { toastActionFailed } from "@/lib/utils";
import { maskSensitiveText } from "@/lib/mask";
import { markRecallIfSearching } from "@/lib/searchRecall";
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
 * 粘贴失败通知的监听器（栈浮标用）。
 *
 * 存在的理由：栈浮标是**独立 webview**，主窗口派发的 `app-toast` DOM 事件它收不到。
 * 所以底层粘贴 API 失败时除了原有 toast，还要额外经这里通知一次，
 * 由 `lib/stack/hudBridge.ts` 转成浮标的失败态。传 `null` 注销。
 */
let pasteFailureListener: ((message: string) => void) | null = null;

/** 注册/注销「粘贴失败」监听（见 `pasteFailureListener`） */
export function onPasteFailure(fn: ((message: string) => void) | null): void {
  pasteFailureListener = fn;
}

/**
 * 粘贴守卫（v6.2 下沉到 API 层，审查 #8）：
 * 所有用户触发的粘贴（卡片/托盘/快捷区/链/序列/编辑器…）都走这里——
 * 敏感内容先弹确认条（[脱敏后粘贴]/[原样粘贴]/[取消]），不再依赖各调用点手动包裹。
 * 内容不敏感 → 直接粘贴（本地检测零 IPC 开销）。
 *
 * `headless`：调用方是**无窗口热键**入口（栈粘贴 / 索引粘贴 / 依次粘贴）时传 true。
 * 它一路透传到 Rust 的 `PasteTrigger`，决定「手动保存的目标窗口」在解析时的权重
 * ——见 `paste_engine.rs::PasteTrigger` 的注释。
 *
 * ❗ headless=true 时**跳过敏感确认、原样直接粘**（2026-09-16 用户拍板）：
 * 确认条是主窗口模态框，而 headless 场景用户人在外部应用、主窗口是隐藏的——
 * 弹框即打断（粘贴无限期挂起在一个看不见的 resolve 上）。这正是 v6.x
 * 「批量/连续粘贴保持原样不打断」同一矛盾；无窗口路径的粘贴内容本就是
 * 用户刚在目标应用里亲手复制的，误粘风险场景与卡片路径不同。主窗口内
 * 路径（headless=false）的确认闸不变。
 */
export async function pasteTextGuarded(text: string, headless = false): Promise<boolean> {
  const trimmed = (text || "").trim();
  if (!trimmed) return false;

  if (headless) return pasteText(trimmed, headless);

  const { text: masked, count } = maskSensitiveText(trimmed);
  if (count > 0 && masked !== trimmed) {
    const check = await pastePrecheck(headless ? "headless" : undefined);
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
    return decision === "mask" ? pasteText(masked, headless) : pasteText(trimmed, headless);
  }
  return pasteText(trimmed, headless);
}

/** 富文本粘贴同样走敏感闸（按纯文本检测；脱敏后连富文本一起换掉）；headless 同上跳过 */
export async function pasteRichGuarded(
  html: string,
  text: string,
  headless = false,
): Promise<boolean> {
  const trimmed = (text || "").trim();
  if (headless) return pasteRich(html, trimmed, headless);
  const { text: masked, count } = maskSensitiveText(trimmed);
  if (count > 0 && masked !== trimmed) {
    const check = await pastePrecheck(headless ? "headless" : undefined);
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
    return decision === "mask" ? pasteRich(masked, masked, headless) : pasteRich(html, trimmed, headless);
  }
  return pasteRich(html, trimmed, headless);
}

/** 粘贴文本，返回是否成功 */
export async function pasteText(text: string, headless = false): Promise<boolean> {
  try {
    // 只在 headless 时补 `trigger`：非 headless 路径保持既有调用形状不变
    // （多传一个 `trigger: null` 会让所有既有 mock 与断言跟着改，而它们与本次改动无关）
    const payload: Record<string, unknown> = { text };
    if (headless) payload.trigger = "headless";
    const result = await invoke<{ success: boolean; error?: string; target_hwnd: number | null; clipboard_written: boolean; wm_paste_sent: boolean } | null>("paste_text", payload);
    if (!result || !result.success) {
      const msg = result?.error || "未知";
      window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `粘贴失败: ${msg}`, type: "error" } }));
      pasteFailureListener?.(msg);
      return false;
    }
    return true;
  } catch (e) {
    logger.error("粘贴失败", e);
    const msg = e instanceof Error ? e.message : String(e);
    window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `粘贴失败: ${msg}`, type: "error" } }));
    pasteFailureListener?.(msg);
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

/**
 * 查询粘贴目标应用（Rust 侧按 `trigger` 解析目标窗口再读进程名）。
 *
 * `trigger` 必须与实际粘贴用**同一个值**，否则会出现「确认条写着 Chrome、
 * 实际粘到记事本」——栈浮标的「→ 应用名」也走这里，理由相同。
 */
export async function pastePrecheck(trigger?: "headless"): Promise<PastePrecheck> {
  try {
    // 同上：省略 trigger 时不传第二个参数，保持既有调用形状
    return trigger
      ? await invoke<PastePrecheck>("paste_precheck", { trigger })
      : await invoke<PastePrecheck>("paste_precheck");
  } catch {
    return { targetApp: null, targetCategory: null };
  }
}

/** 粘贴图片，返回是否成功 */
export async function pasteImage(imagePath: string, headless = false): Promise<boolean> {
  try {
    const payload: Record<string, unknown> = { imagePath };
    if (headless) payload.trigger = "headless";
    await invoke("paste_image", payload);
    return true;
  } catch (e) {
    logger.error("图片粘贴失败", e);
    const msg = e instanceof Error ? e.message : String(e);
    window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `图片粘贴失败: ${msg}`, type: "error" } }));
    pasteFailureListener?.(msg);
    return false;
  }
}

/**
 * 粘贴图文混排内容（CF_HTML 富文本 + 纯文本保底一起写剪贴板），返回是否成功。
 * 目标应用不认富文本时自动退到纯文本，不会粘出空白。
 */
export async function pasteRich(
  htmlFragment: string,
  plainText: string,
  headless = false,
): Promise<boolean> {
  try {
    const payload: Record<string, unknown> = { htmlFragment, plainText };
    if (headless) payload.trigger = "headless";
    await invoke("paste_rich", payload);
    return true;
  } catch (e) {
    logger.error("图文粘贴失败", e);
    const msg = e instanceof Error ? e.message : String(e);
    window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `图文粘贴失败: ${msg}`, type: "error" } }));
    pasteFailureListener?.(msg);
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
  /** 记「找回」与「复制」两个信号都要它。可选：并不是每个调用方都手里有完整条目。 */
  id?: string;
  type: string;
  text: string;
  content?: string;
  content_type?: string | null;
  source?: string | null;
}): Promise<string> {
  // 两个信号都写在函数头而不是四个调用点上：同一个仓库的粘贴信号
  // 就是因为散在各处而漏了三个分支（见 `logItemPasted`）。
  //
  // ① 搜索状态下复制走 = 真的把它找回来用了
  markRecallIfSearching(item.id);
  // ② 复制本身就是「用了它」——剪贴板工具里它比粘贴更常用，
  //   之前却一次都没记过。
  if (item.id) {
    void import("./actionEvents").then(({ logItemCopied }) =>
      logItemCopied({
        id: item.id as string,
        type: item.type,
        content_type: item.content_type,
        source: item.source,
      }),
    );
  }
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

/**
 * 读取剪贴板纯文本。
 *
 * 🔴 不要改回 `navigator.clipboard.readText()`：`writeText` 不弹权限框，
 * 但 **`readText` 会让 WebView 弹出“是否允许读取剪贴板”的浏览器弹框**。
 * 读不到时返回空串：调用方拿它预填，拿不到就留空，不该阻断流程。
 */
export async function readClipboardText(): Promise<string> {
  try {
    return await invoke<string>("read_clipboard_text");
  } catch (e) {
    logger.error("读取剪贴板失败", e);
    return "";
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
