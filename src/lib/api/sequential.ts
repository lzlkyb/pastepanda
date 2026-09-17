/**
 * 依次粘贴 / 索引粘贴 API
 */
import { useAppStore } from "@/stores/appStore";
import { logger } from "@/lib/logger";
import { pasteTextGuarded } from "./paste";

/** 依次粘贴互斥锁：防止快速连按导致同一条被粘贴两次 */
let seqPasteBusy = false;

/** 依次粘贴：粘贴当前指针指向的文本，然后指针+1 */
export async function sequentialPaste() {
  const store = useAppStore.getState();
  // 栈模式与依次粘贴互斥：栈模式下请用栈粘贴热键
  if (store.stackMode) {
    window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: "栈模式进行中，请用栈粘贴快捷键", type: "info" } }));
    return;
  }
  if (seqPasteBusy) return; // 并发重入跳过，避免粘贴同一条
  seqPasteBusy = true;
  try {
    await sequentialPasteInner();
  } finally {
    seqPasteBusy = false;
  }
}

async function sequentialPasteInner() {
  const store = useAppStore.getState();
  // 修复 Low：使用与 UI 一致的过滤后列表（原用未过滤 history，筛选/搜索激活时顺序与界面不符）
  const textItems = store.getFilteredItems().filter((h) => h.type === "text");
  const pointer = store.seqPointer;
  const loop = store.config.sequential_loop;

  logger.info(`[sequentialPaste] 触发 — textItems=${textItems.length}, pointer=${pointer}, loop=${loop}`);

  if (textItems.length === 0) {
    logger.warn("[sequentialPaste] 没有文本记录，跳过");
    window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: "没有可粘贴的文本记录", type: "info" } }));
    return;
  }

  let idx = pointer;
  // 指针越界：循环模式下从头开始，非循环模式下提示并停止
  if (idx >= textItems.length) {
    if (loop) {
      logger.warn(`[sequentialPaste] 指针越界 ${idx} >= ${textItems.length}，循环模式：重置为 0`);
      idx = 0;
      store.setSeqPointer(0);
    } else {
      // 修复 Low：非循环模式到末尾不再静默 return，给出明确反馈
      logger.warn(`[sequentialPaste] 指针越界 ${idx} >= ${textItems.length}，非循环模式：停止`);
      window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: "已到最后一条，无更多可粘贴记录", type: "info" } }));
      return;
    }
  }

  const item = textItems[idx];
  if (!item) {
    logger.error(`[sequentialPaste] textItems[${idx}] 为 null/undefined`);
    return;
  }

  logger.info(`[sequentialPaste] 粘贴第 ${idx + 1}/${textItems.length} 条: ${item.text.slice(0, 30)}...`);

  // 调用后端粘贴引擎，成功后推进指针，失败不推进。
  //
  // 🔴 第三参 headless=true：依次粘贴是**无窗口热键**入口（`hotkey-sequential-paste`
  // 只 emit、不开窗，见 `hotkey_manager.rs`），粘贴引擎据此实时抓取目标窗口
  // ——见 `paste_engine.rs::PasteTrigger` 的注释，那里把本入口与栈粘贴、索引粘贴
  // 并列为同一类。不带这个标记会退回 `WindowBound`，用手动保存值优先：
  // 用户在桌面/任务栏上按热键时 `save_foreground_hwnd` 会拒绝并**保留旧值**，
  // 而主窗口开着时该值永久有效 ⇒ 内容飞到几十分钟前那个窗口。
  const ok = await pasteTextGuarded(item.text, true);
  if (!ok) {
    logger.warn(`[sequentialPaste] 粘贴失败，指针保持 ${idx}`);
    return; // 粘贴失败不推进指针
  }

  // 粘贴信号回写。**热键粘贴此前完全不记**（回写只挂在主窗 Enter 与卡片右键上），
  // 而「按价值豁免过期清理」靠这个信号判定内容有没有被用过——不记就意味着
  // 天天用热键粘的东西，在清理逻辑看来等于从未被用过。
  const { logItemPasted } = await import("@/lib/api/actionEvents");
  logItemPasted(item, idx);

  // Toast 反馈
  window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `已粘贴第 ${idx + 1} 条`, type: "success" } }));

  // 推进指针
  const next = idx + 1;
  if (next >= textItems.length) {
    if (loop) {
      store.setSeqPointer(0);
      logger.info("[sequentialPaste] 循环模式：指针重置为 0");
    } else {
      store.setSeqPointer(next);
      logger.info(`[sequentialPaste] 非循环模式：指针到达末尾 ${next}`);
    }
  } else {
    store.setSeqPointer(next);
  }
}

/** 索引粘贴：粘贴第 N 条文本记录 (1-based) */
export async function indexPaste(n: number) {
  const store = useAppStore.getState();
  // 修复 Low：与 UI 一致，基于过滤后列表定位第 N 条
  const textItems = store.getFilteredItems().filter((h) => h.type === "text");
  const idx = n - 1; // 转为 0-based

  if (idx < 0 || idx >= textItems.length) {
    // U37：越界不再静默，明确告知当前只有多少条
    window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `只有 ${textItems.length} 条文本记录，没有第 ${n} 条`, type: "info" } }));
    return;
  }

  const item = textItems[idx];
  if (!item) return;

  // U1：仅粘贴成功时弹成功提示（pasteText 失败时已自行弹错误 toast）
  //
  // 🔴 headless=true 的理由同 `sequentialPasteInner`：索引粘贴（Ctrl+Alt+1~9）也是
  // 无窗口热键（`hotkey-index-paste` 只 emit、不开窗），必须实时抓取目标窗口。
  const ok = await pasteTextGuarded(item.text, true);
  if (ok) {
    window.dispatchEvent(new CustomEvent("app-toast", { detail: { message: `已粘贴第 ${n} 条`, type: "success" } }));
    // 粘贴信号回写（同 sequentialPasteInner，此前漏记）。索引粘贴的下标是用户
    // 显式指定的位置，如实记录。
    const { logItemPasted } = await import("@/lib/api/actionEvents");
    logItemPasted(item, idx);
  }
}
