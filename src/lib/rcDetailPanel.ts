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
