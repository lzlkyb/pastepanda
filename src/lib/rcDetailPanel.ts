/**
 * rcDetailPanel — 「连接详情」面板开合的单例桥（胶囊质量读数芯片 → RcHud）。
 *
 * 芯片住在浮条身份段、RcHud 住在动作段（作为 `detail` 节点从父级传入），
 * 两者不共享父状态；不想为一次点击把 open 提升到 RcSessionView（290 行顶格）。
 * 与 rcPanelFocus 同款最小单例：RcHud 挂载时登记 toggle，芯片调用；
 * 后登记者赢——同时代只有一个会话浮条挂着 RcHud，可接受。
 */
let toggleFn: (() => void) | null = null;

export function registerRcDetailToggle(fn: () => void): () => void {
  toggleFn = fn;
  return () => {
    if (toggleFn === fn) toggleFn = null;
  };
}

export function toggleRcDetail(): void {
  toggleFn?.();
}

/* 开合通知（2026-09-27 审查补）：浮条宿主需要知道 ⓘ 面板开着没有——
   与下拉/⋯面板同口径锁显，否则面板随 2.5s 淡出一起被带走。 */
let openListener: ((open: boolean) => void) | null = null;

/** RcHud 在 open 变化时调用（effect 内，卸载时调 false）。 */
export function setRcDetailOpen(open: boolean): void {
  openListener?.(open);
}

/** 浮条宿主订阅开合。同一时刻只有一个浮条宿主，后登记者赢（与 toggle 同口径）。 */
export function onRcDetailOpen(cb: (open: boolean) => void): () => void {
  openListener = cb;
  return () => {
    if (openListener === cb) openListener = null;
  };
}
