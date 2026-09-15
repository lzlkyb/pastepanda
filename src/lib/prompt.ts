/**
 * lib/prompt.ts —— 统一的 promise 输入弹窗（替代散落的 window.prompt）。
 *
 * 与 `confirm.ts` / ConfirmDialog 同一视觉语言；调用方式：
 *   const name = await promptDialog({ title, defaultValue });
 *   if (name === null) return; // 取消
 * 返回 Promise<string | null>：确定 = 输入值（可能为空串），取消/Esc = null。
 * 由 PromptDialogHost（挂在 App 根部）渲染。
 */

export interface PromptRequest {
  title: string;
  /** 可选说明文案（单行即可）。 */
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmText?: string;
  cancelText?: string;
  resolve: (v: string | null) => void;
}

let current: PromptRequest | null = null;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

export function promptDialog(opts: {
  title: string;
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmText?: string;
  cancelText?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    // 与 confirmDialog 同策略：已有待决请求时拒新，避免前一个 Promise 永挂。
    if (current) {
      resolve(null);
      return;
    }
    current = { ...opts, resolve };
    notify();
  });
}

export function resolvePrompt(v: string | null) {
  if (current) {
    current.resolve(v);
    current = null;
    notify();
  }
}

export function getPrompt(): Omit<PromptRequest, "resolve"> | null {
  return current
    ? {
        title: current.title,
        message: current.message,
        placeholder: current.placeholder,
        defaultValue: current.defaultValue,
        confirmText: current.confirmText,
        cancelText: current.cancelText,
      }
    : null;
}

export function subscribePrompt(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
