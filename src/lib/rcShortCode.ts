/** 仅识别带 PastePanda 前缀的剪贴板文本，避免把普通数字误当配对邀请。 */
export function shortCodeFromClipboard(text: string): string | null {
  const match = /^\s*PP-(\d{4})-(\d{4})\s*$/i.exec(text);
  return match ? `${match[1]}${match[2]}` : null;
}

export function shortCodeFromInput(text: string): string | null {
  const sharedCode = shortCodeFromClipboard(text);
  if (sharedCode) return sharedCode;
  const digits = text.replace(/[\s-]/g, "");
  return /^\d{8}$/.test(digits) ? digits : null;
}

export function formatShortCode(code: string): string {
  return `${code.slice(0, 4)} ${code.slice(4)}`;
}
