/**
 * 栈浮标（Stack HUD）的**唯一同步出口**。
 *
 * ## 为什么需要它
 *
 * 浮标是**独立的 webview 与 JS 上下文**：主窗口的 zustand store、`app-toast`
 * DOM 事件、任何主窗口内的状态，它一个都拿不到。状态只能经 Rust 的
 * `emit` 广播过去（`stack_hud.rs` → `stack-hud-update`）。
 *
 * ## 为什么必须"唯一"
 *
 * 两个地方各推一次状态，早晚会漂移出「浮标显示 A、实际做了 B」——
 * 这与历史事故「提示已粘贴却没内容」同形。所有浮标状态变更都必须经本文件，
 * 不要在别处直接 `invoke("stack_hud_update")`。
 *
 * ## 一条硬约束
 *
 * 浮标上的「→ 应用名」必须来自粘贴引擎解析目标的**同一个函数、同一个 trigger**
 * （`pastePrecheck("headless")`）。在这里重算一遍就会出现
 * 「浮标写着 Chrome、实际粘到记事本」。
 */
import { invoke } from "@tauri-apps/api/core";
import { logger } from "@/lib/logger";
import { useAppStore } from "@/stores/appStore";
import { onPasteFailure, pastePrecheck } from "@/lib/api/paste";
import type { StackHudProgress, StackHudState } from "./types";

/** `done` 态留白多久再隐藏（给用户"全部贴完了"的确认时间） */
const DONE_HOLD_MS = 1500;

/** `success` / `error` 态停留多久后回到「收集中」（让用户能看到"下一个粘到哪"） */
const RECOVER_MS = 3000;

/** 把 `ctrl+alt+p` 格式化成 `Ctrl+Alt+P`（纯展示，不改配置） */
function hotkeyLabel(): string {
  const raw = useAppStore.getState().config.stack_paste_hotkey || "ctrl+alt+p";
  return raw
    .split("+")
    .map((k) => (k.length > 0 ? k.charAt(0).toUpperCase() + k.slice(1) : k))
    .join("+");
}

/** 预览截断长度：240px 宽 11px 字号下单行约放 20 个汉字，JS 侧先粗截控制负载，
 *  精确省略号交给 CSS `text-overflow`（两者叠加不冲突）。 */
const PREVIEW_MAX_CHARS = 30;

/**
 * 进度徽章：与 `StackBanner` 同一账（`stackPasted` / `stackCollected`）。
 * 分母取 `max(收集数, 已粘贴+剩余)` —— 50 条上限截断时收集数更大，避免分母虚低。
 * done 终态不调用（exitStackMode 已清零，且终态文案本身就是确认）。
 */
function progressFromStore(remaining: number): StackHudProgress | null {
  const s = useAppStore.getState();
  if (!s.stackMode && s.stackPasted === 0) return null;
  const total = Math.max(s.stackCollected, s.stackPasted + remaining);
  if (total <= 0) return null;
  return { done: s.stackPasted, total };
}

/**
 * 下一条要粘贴的内容预览（`stackItems[0]`，与 `stackPasteNext` 弹出的同一条）。
 *
 * 图片/文件内容不可读，给占位符；文字取**第一个非空行**——多行内容只展示
 * 能读的那行，全部行都空则也占位，避免浮标上出现一行「看起来坏了」的空白。
 */
export function nextPreview(): string | null {
  const top = useAppStore.getState().stackItems[0];
  if (!top) return null;
  if (top.type === "image") return "[图片]";
  if (top.type === "file") return "[文件]";
  const firstLine =
    (top.text || "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const preview = firstLine.length > 0 ? firstLine : "[空内容]";
  return preview.length > PREVIEW_MAX_CHARS
    ? preview.slice(0, PREVIEW_MAX_CHARS) + "…"
    : preview;
}

/** 推一次状态。**所有**浮标更新都必须经这里。 */
function push(state: StackHudState): void {
  invoke("stack_hud_update", { state }).catch((e) => logger.warn("推送栈浮标状态失败", e));
}

/**
 * 解析目标应用名 —— 走粘贴引擎的同一个函数、同一个 trigger。
 * 与 `stackPasteNext` 走的是同一条解析链，所以浮标显示的就是实际会粘到的地方。
 */
async function resolveTarget(): Promise<string | null> {
  const check = await pastePrecheck("headless");
  return check.targetApp;
}

/** 「收集中」态的推送：需要目标应用名；用序号丢弃过期回调 */
async function pushCollecting(count: number): Promise<void> {
  const seq = ++collectSeq;
  const target = await resolveTarget();
  if (seq !== collectSeq) return;
  push({
    phase: "collecting",
    count,
    target,
    hint: null,
    next: nextPreview(),
    hotkey: hotkeyLabel(),
    progress: progressFromStore(count),
    anchorKind: null,
  });
}

let recoverTimer: ReturnType<typeof setTimeout> | null = null;
/** pushCollecting 序号：丢弃过期的 resolveTarget 回调，防止条数回退（P1.2） */
let collectSeq = 0;

/** 活跃状态（success / error）停留一会儿后回到「收集中」 */
function scheduleRecover(): void {
  if (recoverTimer !== null) clearTimeout(recoverTimer);
  recoverTimer = setTimeout(() => {
    recoverTimer = null;
    const store = useAppStore.getState();
    if (!store.stackMode) return;
    void pushCollecting(store.stackItems.length);
  }, RECOVER_MS);
}

/** 取消待执行的恢复计时（退出栈模式 / 新事件到来时） */
function cancelRecover(): void {
  if (recoverTimer !== null) {
    clearTimeout(recoverTimer);
    recoverTimer = null;
  }
}

// ===== 对外：栈的生命周期节点 =====

/** 进入栈模式：显示浮标并推初始状态 */
export async function hudStackModeEntered(): Promise<void> {
  cancelRecover();
  await pushCollecting(useAppStore.getState().stackItems.length);
  invoke("stack_hud_show").catch((e) => logger.warn("显示栈浮标失败", e));
}

/** 退出栈模式（主动退出 / 栈被清空）：立即隐藏 */
export function hudStackModeExited(): void {
  cancelRecover();
  invoke("stack_hud_hide", { delayMs: null }).catch((e) =>
    logger.warn("隐藏栈浮标失败", e),
  );
}

/** 粘贴成功：显示剩余条数 */
export async function hudPastedOk(remaining: number): Promise<void> {
  push({
    phase: "success",
    count: remaining,
    target: null,
    hint: null,
    next: nextPreview(),
    hotkey: hotkeyLabel(),
    progress: progressFromStore(remaining),
    anchorKind: null,
  });
  scheduleRecover();
}

/**
 * 粘贴失败：显示失败态。
 *
 * 副行固定写「这条已保留在栈里」——用户此刻最怕的是**丢数据**，
 * 而这句话才是他需要确认的事。具体失败原因（未找到目标窗口 / 无法切换 /
 * 目标已关闭）由 `reason` 参数记进日志，也由底层 API 的 toast 承载（主窗可见时）。
 * 浮标 208px 宽放不下完整原因，硬塞会被省略号截断。
 */
export function hudPastedFailed(reason: string): void {
  logger.warn("栈粘贴失败", reason);
  const remaining = useAppStore.getState().stackItems.length;
  push({
    phase: "error",
    count: remaining,
    target: null,
    hint: "这条已保留在栈里",
    // 失败条目未出队，stackItems[0] 仍是它 —— 预览行让用户确认「卡住的正是这条」
    next: nextPreview(),
    hotkey: hotkeyLabel(),
    progress: progressFromStore(remaining),
    anchorKind: null,
  });
  scheduleRecover();
}

/** 全部粘贴完毕：显示终态，随后自动隐藏 */
export function hudAllDone(): void {
  cancelRecover();
  push({
    phase: "done",
    count: 0,
    target: null,
    hint: "已退出栈模式",
    next: null, // 栈已空，预览行不渲染
    hotkey: hotkeyLabel(),
    // 终态不显示进度徽章：exitStackMode 已清零 stackPasted/Collected，
    // 「全部粘贴完毕」本身就是确认，再拼一个 0/0 反而制造困惑
    progress: null,
    anchorKind: null,
  });
  invoke("stack_hud_hide", { delayMs: DONE_HOLD_MS }).catch((e) =>
    logger.warn("隐藏栈浮标失败", e),
  );
}

// ===== 自动跟随 =====

let autoFollowStarted = false;

/**
 * 启动浮标的自动跟随（收集到新条目时刷新条数 + 目标应用名）。
 *
 * ❗ **只应由主窗口调用一次**（`lib/api/init.ts` 的 `initBackend`），不要放在模块顶层。
 *
 * 原因：`hudBridge.ts` 经 `lib/api` → `QuickPastePanel` / `DocEditor` 这条链，
 * 也会被**独立窗口**加载（快捷面板、全屏编辑器各自有独立的 JS 上下文与 store 实例）。
 * 在那些 webview 里注册订阅 = 两个上下文各推一次浮标状态，
 * 正是本文件开头那条「唯一出口」要杜绝的漂移源。
 *
 * 只处理**条数增加**（= 收集），不处理减少 —— 减少发生在粘贴出队与删除，
 * 那两条路径各有显式调用（`hudPastedOk` / `hudStackModeExited`），自动订阅再推一次
 * 会与它们抢时序：`hudPastedOk` 是 async（要解析目标），订阅那次是同步触发，
 * 两者先后不确定，可能把浮标停在错误的「收集中」上。
 *
 * 顺带刷新目标应用名：用户复制内容时人就在目标应用里，此刻的前台就是他
 * 接下来想粘到的地方 —— 这正是"在哪儿收集，就粘到哪儿"。
 */
export function startHudAutoFollow(): void {
  if (autoFollowStarted) return;
  autoFollowStarted = true;

  useAppStore.subscribe((state, prev) => {
    if (!state.stackMode) return;
    if (state.stackItems.length <= prev.stackItems.length) return;
    void pushCollecting(state.stackItems.length);
  });

  /**
   * 底层粘贴 API 失败时通知浮标。
   *
   * 浮标收不到主窗口的 `app-toast` DOM 事件，所以 `lib/api/paste.ts` 额外经
   * `onPasteFailure` 通知一次。只在栈模式下推：非栈路径的粘贴失败主窗口自己
   * 有 toast，而那时浮标本就不该存在。
   */
  onPasteFailure((message) => {
    if (!useAppStore.getState().stackMode) return;
    hudPastedFailed(message);
  });
}
