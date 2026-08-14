/**
 * 剪贴板栈 API — 栈模式切换、栈粘贴、全部粘贴
 */
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/stores/appStore";
import { logger } from "@/lib/logger";
import { splitTableToRows } from "@/lib/tableSplit";
import { pasteTextGuarded, pasteImage, pasteRichGuarded } from "./paste";

/** 同步栈模式状态到后端（托盘图标） */
function syncStackModeToBackend(active: boolean) {
  invoke("set_stack_mode", { active }).catch((e) => logger.warn("同步栈模式到后端失败", e));
}

/** 切换栈模式 */
export function toggleStackMode() {
  const store = useAppStore.getState();
  const active = !store.stackMode;
  if (active) {
    store.setStackMode(true);
    syncStackModeToBackend(true);
    const pasteKey = store.config.stack_paste_hotkey || "ctrl+alt+p";
    window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `栈模式已开启 · Ctrl+C 收集 · ${pasteKey} 粘贴`, type: "info" } }));
  } else {
    store.exitStackMode();
    syncStackModeToBackend(false);
    window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: "栈模式已退出", type: "info" } }));
  }
}

/** 退出栈模式（手动退出，保留历史记录） */
export function exitStack() {
  useAppStore.getState().exitStackMode();
  syncStackModeToBackend(false);
  window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: "栈模式已退出", type: "info" } }));
}

/** 栈粘贴互斥锁：防止快速连按/全部粘贴与手动粘贴并发导致重复粘贴或跳过条目 */
let stackPasteBusy = false;
let stackPasteAllRunning = false;

/** 栈粘贴：粘贴栈顶条目并弹出，栈空自动退出 */
export async function stackPasteNext(): Promise<boolean> {
  if (stackPasteBusy) return false; // 并发重入直接跳过，避免重复粘贴同一条
  stackPasteBusy = true;
  try {
    const store = useAppStore.getState();
    if (!store.stackMode) return false;

    const item = store.stackItems[0];
    if (!item) {
      // 栈空 → 自动退出
      store.exitStackMode();
      syncStackModeToBackend(false);
      window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: "栈已清空，自动退出栈模式", type: "success" } }));
      return false;
    }

    let ok: boolean;
    if (item.type === "image" && item.content) {
      ok = await pasteImage(item.content);
    } else if (item.type === "rich" && item.content) {
      ok = await pasteRichGuarded(item.content, item.text);
    } else if (item.type === "file") {
      // 文件粘贴完整路径（content），与列表回车粘贴行为保持一致
      ok = await pasteTextGuarded(item.content || item.text);
    } else {
      ok = await pasteTextGuarded(item.text);
    }

    if (!ok) return false;

    store.stackMarkPasted();

    // P3 粘贴+Tab 推进：开关开时，每次粘贴成功后略等目标应用处理完粘贴再补发 Tab。
    // 失败只警告不阻断主流程——Tab 没推进成功最差的结果是用户自己按一下 Tab，
    // 不应让它把已经成功的粘贴标记成失败。
    if (useAppStore.getState().stackTabAdvance) {
      await new Promise((r) => setTimeout(r, 60));
      invoke("paste_send_tab").catch((e) => logger.warn("Tab 推进失败", e));
    }

    const remaining = useAppStore.getState().stackItems.length;
    if (remaining === 0) {
      // 全部粘贴完毕 → 自动退出
      useAppStore.getState().exitStackMode();
      syncStackModeToBackend(false);
      window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: "全部粘贴完毕，已退出栈模式", type: "success" } }));
    } else if (!stackPasteAllRunning) {
      // 「全部粘贴」进行中不逐条弹这个进度 toast——横幅本来就有实时进度条，连发好几个 toast 只会刷屏
      window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `已粘贴，剩余 ${remaining} 条`, type: "success" } }));
    }
    return true;
  } finally {
    stackPasteBusy = false;
  }
}

/** 全部粘贴：间隔 300ms 连续粘贴剩余全部条目 */
let stackPasteAllAbort = false; // U58：中止标志

/** U58：查询「全部粘贴」是否进行中 */
export function isStackPasteAllRunning(): boolean {
  return stackPasteAllRunning;
}

/** U58：中止「全部粘贴」循环（全局热键 / 横幅按钮 / Esc 均可调用） */
export function abortStackPasteAll() {
  if (stackPasteAllRunning) stackPasteAllAbort = true;
}

/**
 * B 方案（热键自适应）：栈未开时按粘贴热键，若剪贴板最新内容（history[0]）看起来像表格 →
 * 自动开栈、按行拆分入栈并贴第一条。读 history[0] 而不用 navigator.clipboard.readText()：
 * 后者依赖文档焦点，而这个场景焦点恰恰在外部应用上，不可靠。
 * 返回 false 时调用方应继续走原有的 stackPasteNext() 流程（栈已开 / 非表格 都不改变现有习惯）。
 */
export async function stackAutoSplitAndPasteFirst(): Promise<boolean> {
  const store = useAppStore.getState();
  if (store.stackMode || !store.config.table_split_enabled) return false;
  const top = store.history[0];
  if (!top) return false;
  const split = splitTableToRows(top.text || "", {
    format: store.config.table_split_format,
    includeHeader: store.config.table_split_include_header,
  });
  if (!split || split.rows.length === 0) return false;

  store.setStackMode(true);
  syncStackModeToBackend(true);
  useAppStore.getState().stackPushOrSplit(top);
  const pasted = await stackPasteNext();
  // 只在真正粘贴成功时才报“已粘贴第 1 条”；失败（如首行命中敏感内容确认框被取消）时不误报成功，
  // 失败的具体提示交给 pasteText/pasteTextGuarded 自己的流程（已有失败 toast 或用户主动取消）。
  if (pasted) {
    const remaining = useAppStore.getState().stackItems.length;
    window.dispatchEvent(new CustomEvent("app-toast", {
      detail: { message: `检测到表格 · 已自动拆行入栈并粘贴第 1 条（剩余 ${remaining} 条）`, type: "info" },
    }));
  }
  return true;
}

export async function stackPasteAll() {
  if (stackPasteAllRunning) return; // 防止双击「全部粘贴」启动两个循环
  const store = useAppStore.getState();
  if (!store.stackMode || store.stackItems.length === 0) return;
  stackPasteAllRunning = true;
  stackPasteAllAbort = false;
  useAppStore.setState({ stackPasteAllActive: true }); // U58：横幅显示进度条 + 中止按钮
  let aborted = false;
  try {
    while (useAppStore.getState().stackMode && useAppStore.getState().stackItems.length > 0) {
      if (stackPasteAllAbort) { // U58：用户中止
        aborted = true;
        break;
      }
      const ok = await stackPasteNext();
      if (!ok) break;
      // U58：分段 sleep，中止响应延迟 ≤100ms
      for (let i = 0; i < 3; i++) {
        if (stackPasteAllAbort) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  } finally {
    stackPasteAllRunning = false;
    stackPasteAllAbort = false;
    useAppStore.setState({ stackPasteAllActive: false });
    if (aborted) {
      const remaining = useAppStore.getState().stackItems.length;
      window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `已中止全部粘贴，剩余 ${remaining} 条`, type: "info" } }));
    }
  }
}
