/**
 * 剪贴板栈 API — 栈模式切换、栈粘贴、全部粘贴
 */
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/stores/appStore";
import { logger } from "@/lib/logger";
import { splitTableToRows, isTableSplitCandidate } from "@/lib/tableSplit";
import {
  hudStackModeEntered,
  hudStackModeExited,
  hudPastedOk,
  hudAllDone,
} from "@/lib/stack/hudBridge";
import { loopProgress } from "@/lib/stack/loop";

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
    // 栈是无窗口热键操作，用户此刻的视线在**别的应用**里：
    // 主窗口的横幅与 toast 他一条都看不到，反馈必须由浮标承载。
    void hudStackModeEntered();
    const pasteKey = store.config.stack_paste_hotkey || "ctrl+alt+p";
    window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `栈模式已开启 · Ctrl+C 收集 · ${pasteKey} 粘贴`, type: "info" } }));
  } else {
    store.exitStackMode();
    syncStackModeToBackend(false);
    hudStackModeExited();
    window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: "栈模式已退出", type: "info" } }));
  }
}

/** 退出栈模式（手动退出，保留历史记录） */
export function exitStack() {
  useAppStore.getState().exitStackMode();
  syncStackModeToBackend(false);
  hudStackModeExited();
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
      hudStackModeExited();
      window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: "栈已清空，自动退出栈模式", type: "success" } }));
      return false;
    }

    // 按类型分派 + 粘贴信号回写统一走 pasteHistoryItem（此前这段分派是本文件的
    // 第 3 份拷贝）。栈粘贴按栈序出栈、没有列表位置，故下标传 -1。
    // 第三参 headless=true：栈粘贴是**无窗口热键**操作，粘贴引擎据此实时抓取目标
    // （见 `paste_engine.rs::PasteTrigger`），不会把内容送到几十分钟前那个窗口去。
    const { pasteHistoryItem } = await import("@/lib/pasteItem");
    const { ok } = await pasteHistoryItem(item, -1, true);

    // 失败的具体提示由底层 API 负责（toast + `onPasteFailure` → 浮标失败态）。
    // 这里不再推浮标状态，避免两处各推一次把浮标停在错误的状态上。
    if (!ok) return false;

    store.stackMarkPasted();

    // P3 粘贴+Tab 推进：开关开时，每次粘贴成功后略等目标应用处理完粘贴再补发 Tab。
    // 失败只警告不阻断主流程——Tab 没推进成功最差的结果是用户自己按一下 Tab，
    // 不应让它把已经成功的粘贴标记成失败。
    if (useAppStore.getState().stackTabAdvance) {
      await new Promise((r) => setTimeout(r, 60));
      invoke("paste_send_tab").catch((e) => logger.warn("Tab 推进失败", e));
    }

    const after = useAppStore.getState();
    const info = loopProgress(after.stackItems, after.stackDoneIds);
    if (after.stackItems.length === 0) {
      // 全部粘贴完毕 → 自动退出
      // ❗ 这条路在**循环态下走不到**：那时队列永不清空（贴过的那条轮转到队尾），
      //   所以循环的终点只有一个 —— 退出栈模式。这也是浮标副行必须写「退出即停」的原因。
      useAppStore.getState().exitStackMode();
      syncStackModeToBackend(false);
      hudAllDone();
      window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: "全部粘贴完毕，已退出栈模式", type: "success" } }));
    } else {
      // 「全部粘贴」进行中不逐条弹这个进度 toast——横幅本来就有实时进度条，连发好几个 toast 只会刷屏。
      // 浮标则相反：它是唯一出窗口的通道，循环中每一步的剩余条数正是用户想看的。
      // ❗ 报的是**本轮**剩余而非队列长度：循环态下队列长度是常数，报它等于每步显示同一个数字。
      if (!stackPasteAllRunning) {
        window.dispatchEvent(new CustomEvent("app-toast", {
          detail: {
            message: after.stackLoopPaste
              ? `已粘贴 · 第 ${after.stackLoopRound} 轮 · 本轮还剩 ${info.remaining} 条`
              : `已粘贴，剩余 ${info.remaining} 条`,
            type: "success",
          },
        }));
      }
      void hudPastedOk(info.remaining);
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
  // ❗ 这里以前**没有**类型判据，而 `stackPushOrSplit` 有，于是同一张表格
  //   「先开栈再复制」拆不了、「直接按热键」却拆得动。两个入口必须同一判据（规则 #11）。
  if (!isTableSplitCandidate(top.type)) return false;
  const split = splitTableToRows(top.text || "", {
    format: store.config.table_split_format,
    includeHeader: store.config.table_split_include_header,
  });
  if (!split || split.rows.length === 0) return false;

  store.setStackMode(true);
  syncStackModeToBackend(true);
  // 这条路径也会自动开栈（用户没按过开栈热键），浮标同样要亮起来
  await hudStackModeEntered();
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
  /**
   * ❗ 循环态下 `stackItems.length > 0` **永成立**（贴过的轮转到队尾，不出栈），
   * 拿它当循环条件就是贴不停 —— 用户最初报的「什么时候结束」正是这个形状。
   *
   * 改成按**轮次**判定：贴完本轮（`stackLoopRound` 自增）即停，不进下一轮。
   * 于是「▶ 全部」在循环态下被收敛成一个有界动作「把本轮剩下的贴完」，
   * 按钮也保住了可用性（不必禁用）。
   *
   * 起始轮次在循环外取一次：中途用户关掉循环开关时 `toggleStackLoopPaste`
   * 会把轮次归 1，若 1 === startRound 会误判成「进了新轮」，所以下面同时用
   * `cur.stackLoopPaste` 兜住 —— 开关一关就按非循环态语义（队列贴空即停）。
   */
  const startRound = store.stackLoopRound;
  let aborted = false;
  try {
    while (useAppStore.getState().stackMode) {
      const cur = useAppStore.getState();
      if (cur.stackItems.length === 0) break;
      if (cur.stackLoopPaste && cur.stackLoopRound !== startRound) break;
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
      const cur = useAppStore.getState();
      const info = loopProgress(cur.stackItems, cur.stackDoneIds);
      window.dispatchEvent(new CustomEvent("app-toast", {
        detail: {
          message: cur.stackLoopPaste
            ? `已中止 · 第 ${cur.stackLoopRound} 轮 · 本轮还剩 ${info.remaining} 条`
            : `已中止全部粘贴，剩余 ${info.remaining} 条`,
          type: "info",
        },
      }));
    }
  }
}
