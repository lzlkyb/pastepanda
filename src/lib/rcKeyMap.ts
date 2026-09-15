/**
 * DOM 键盘事件 → Win32 虚拟键码（远程电脑 R2）。
 * 优先用 `code`（物理键，不随布局变），再退回 `key`。
 */

export interface KeyLike {
  code: string;
  key: string;
}

const CODE_MAP: Record<string, number> = {
  Enter: 0x0d,
  Escape: 0x1b,
  Tab: 0x09,
  Backspace: 0x08,
  Delete: 0x2e,
  Insert: 0x2d,
  Space: 0x20,
  Home: 0x24,
  End: 0x23,
  PageUp: 0x21,
  PageDown: 0x22,
  ArrowUp: 0x26,
  ArrowDown: 0x28,
  ArrowLeft: 0x25,
  ArrowRight: 0x27,
  CapsLock: 0x14,
  NumLock: 0x90,
  ScrollLock: 0x91,
  PrintScreen: 0x2c,
  Pause: 0x13,
  ContextMenu: 0x5d,
  ShiftLeft: 0xa0,
  ShiftRight: 0xa1,
  ControlLeft: 0xa2,
  ControlRight: 0xa3,
  AltLeft: 0xa4,
  AltRight: 0xa5,
  MetaLeft: 0x5b,
  MetaRight: 0x5c,
  Minus: 0xbd,
  Equal: 0xbb,
  BracketLeft: 0xdb,
  BracketRight: 0xdd,
  Backslash: 0xdc,
  Semicolon: 0xba,
  Quote: 0xde,
  Backquote: 0xc0,
  Comma: 0xbc,
  Period: 0xbe,
  Slash: 0xbf,
  NumpadAdd: 0x6b,
  NumpadSubtract: 0x6d,
  NumpadMultiply: 0x6a,
  NumpadDivide: 0x6f,
  NumpadDecimal: 0x6e,
  NumpadEnter: 0x0d,
};

/** 键盘事件 → VK；无法映射时返回 null（不注入）。 */
export function keyToVk(e: KeyLike): number | null {
  const { code, key } = e;

  const hit = CODE_MAP[code];
  if (hit != null) return hit;

  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
  if (/^Numpad[0-9]$/.test(code)) return 0x60 + Number(code.slice(6));
  if (/^F([1-9]|1[0-2])$/.test(code)) return 0x70 + (Number(code.slice(1)) - 1);

  // 退回：单字符（含部分布局下的可打印键）
  if (key.length === 1) {
    const up = key.toUpperCase();
    const c = up.charCodeAt(0);
    if (c >= 0x30 && c <= 0x39) return c;
    if (c >= 0x41 && c <= 0x5a) return c;
  }

  // key 名兜底（无 code 时）
  const byKey = CODE_MAP[key];
  if (byKey != null) return byKey;
  if (key === "Shift") return 0x10;
  if (key === "Control") return 0x11;
  if (key === "Alt") return 0x12;

  return null;
}

/** 是否应交给远程（排除浏览器/系统组合键里明显不该拦的）。 */
export function shouldForwardToRemote(e: KeyLike & { ctrlKey?: boolean; metaKey?: boolean }): boolean {
  // Win 键单独/组合不转发，避免卡死本机
  if (e.code === "MetaLeft" || e.code === "MetaRight") return false;
  return true;
}
