/**
 * SoftKeyboardBridge — 隐藏 input 桥接手机 IME（design §5.1）。
 *
 * 手机软键盘必须由聚焦的输入框唤起：一颗固定定位、视觉不可见的 <input>
 * 承担这个角色。打字档（默认）：IME 组串 → compositionend 取整串 →
 * 走乙-① 的 `{kind:"text"}` 通道（对端 KEYEVENTF_UNICODE 注入），候选期
 * keydown 一律不发（e.isComposing 判据，桌面 useRcImeGuard 同口径）。
 * 直传档：keydown/keyup 逐键转发，由调用方 keyToVk 后发 VK。
 *
 * 类而非 hook：生命周期跟会话壳走，React 18 StrictMode 双挂载下
 * mount/destroy 必须严格成对。
 */
export interface SoftKeyboardHandlers {
  /** 打字档：IME 选字完成。 */
  onText(text: string): void;
  /** 直传档：非候选期的物理键（软键盘也走这条）。 */
  onDirectKeyDown(e: KeyboardEvent): void;
  onDirectKeyUp(e: KeyboardEvent): void;
  /** 聚焦状态 = 软键盘开合的可靠信号（横屏沉浸据此暂停自动隐藏）。 */
  onFocusChange(focused: boolean): void;
}

export class SoftKeyboardBridge {
  private input: HTMLInputElement | null = null;
  private readonly handlers: SoftKeyboardHandlers;
  private composing = false;

  constructor(handlers: SoftKeyboardHandlers) {
    this.handlers = handlers;
  }

  mount(): void {
    if (this.input) return;
    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.autocapitalize = "none";
    input.spellcheck = false;
    // 视觉不可见但必须可聚焦：display:none / hidden 拿不到 IME
    input.setAttribute("aria-hidden", "true");
    input.style.position = "fixed";
    input.style.top = "-40px";
    input.style.left = "0";
    input.style.width = "1px";
    input.style.height = "1px";
    input.style.opacity = "0";
    input.style.border = "none";
    input.style.padding = "0";

    input.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    input.addEventListener("compositionend", () => {
      this.composing = false;
      const text = input.value;
      input.value = "";
      if (text) this.handlers.onText(text);
    });
    input.addEventListener("keydown", (e) => {
      if (this.composing || e.isComposing) return; // 候选期零键外发
      this.handlers.onDirectKeyDown(e);
    });
    input.addEventListener("keyup", (e) => {
      if (this.composing || e.isComposing) return;
      this.handlers.onDirectKeyUp(e);
    });
    input.addEventListener("focus", () => this.handlers.onFocusChange(true));
    input.addEventListener("blur", () => this.handlers.onFocusChange(false));

    document.body.appendChild(input);
    this.input = input;
  }

  focus(): void {
    this.input?.focus();
  }

  blur(): void {
    this.input?.blur();
  }

  get focused(): boolean {
    return !!this.input && document.activeElement === this.input;
  }

  destroy(): void {
    this.input?.blur();
    this.input?.remove();
    this.input = null;
    this.composing = false;
  }
}
