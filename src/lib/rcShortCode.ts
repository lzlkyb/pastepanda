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

/** 二维码载荷形态（`PP-XXXX-XXXX`）：`shortCodeFromClipboard` / `shortCodeFromInput`
 *  都认，对端扫到即可直接进输入框。桌面出示侧与手机出示侧共用同一构造——
 *  分叉的表现是「电脑上的码手机扫不出来」（2026-10-01 联调实测踩过）。 */
export function pairQrPayload(code: string): string {
  return `PP-${code.slice(0, 4)}-${code.slice(4)}`;
}
