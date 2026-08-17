/**
 * 截图 OCR 文本的敏感内容扫描（红线兜底）。纯函数，从 ScreenshotOverlay 抽出以便单测。
 */

/**
 * 全文敏感扫描（OCR 多行文本）→ 返回命中类型名；无命中返回 null。
 *
 * 与 secret.ts 的「单条密钥识别」互补：这里扫的是整段文本里是否夹杂密钥/密码形态，
 * 用于截图场景的「防止自动发云端」红线兜底（命中即拦截，用户确认才放行）。
 */
export function detectSensitiveText(text: string): string | null {
  if (!text) return null;
  const pats: [RegExp, string][] = [
    [/sk-[A-Za-z0-9_-]{16,}/, "API Key（sk-*）"],
    [/AKIA[0-9A-Z]{16}/, "AWS Access Key"],
    [/ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}/, "GitHub Token"],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "私钥（PEM）"],
    [/password\s*[:=]\s*["']?[^\s"']{6,}/i, "密码"],
    [/api[_-]?key\s*[:=]\s*["']?[^\s"']{8,}/i, "API Key"],
    [/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, "JWT"],
  ];
  for (const [re, label] of pats) {
    if (re.test(text)) return label;
  }
  return null;
}
