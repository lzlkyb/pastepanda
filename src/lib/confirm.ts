/**
 * lib/confirm.ts —— 审查：统一的 promise 确认弹窗（替代散落的 window.confirm）。
 *
 * 与项目 ConfirmDialog 同一视觉语言；调用方式：
 *   if (await confirmDialog({ title, message, confirmText, variant })) { ... }
 * 返回 Promise<boolean>：确认 = true，取消/关闭 = false。
 * 由 ConfirmDialogHost（挂在 App 根部）渲染。
 */

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "danger" | "warning";
  resolve: (v: boolean) => void;
}

let current: ConfirmRequest | null = null;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

export function confirmDialog(opts: {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "danger" | "warning";
}): Promise<boolean> {
  return new Promise((resolve) => {
    // 已有待决请求时**不覆盖**，直接把新请求当取消。
    //
    // 原实现是 `current = {...}` 直赋，前一个请求的 resolve 就此丢失 →
    // 那个 `await confirmDialog(...)` **永远不返回**，调用方流程静默停住
    // （不报错也不继续）。两个异步流程各自要确认、或同一入口被双击就会碰上。
    //
    // 选“拒新”而不是“顶掉旧”：屏幕上已经有一个框、用户正在读它。把它换成
    // 新文案会让用户对着新问题点下他为旧问题准备的那一下——那是更危险的错。
    if (current) {
      resolve(false);
      return;
    }
    current = { ...opts, resolve };
    notify();
  });
}

export function resolveConfirm(v: boolean) {
  if (current) {
    current.resolve(v);
    current = null;
    notify();
  }
}

export function getConfirm(): Omit<ConfirmRequest, "resolve"> | null {
  return current ? { title: current.title, message: current.message, confirmText: current.confirmText, cancelText: current.cancelText, variant: current.variant } : null;
}

export function subscribeConfirm(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
