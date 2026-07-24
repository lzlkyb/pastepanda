/**
 * secret.ts — 密钥脱敏与类型识别（P4 SecretEditor + Card 脱敏共用）。
 *
 * 类型识别规则与 Rust ContentClassifier::is_secret 对齐：
 *   JWT（三段式 >50）/ AWS Access Key（AKIA 开头恰 20 位）/
 *   GitHub Token（ghp_、github_pat_ 前缀 >30）/ 通用 Base64。
 */

export type SecretKind = "JWT" | "AWS" | "GitHub" | "Base64" | "密钥";

const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** 识别密钥类型（供徽章展示；与分类器判定同源，识别不出时回退通用"密钥"） */
export function detectSecretKind(text: string): SecretKind {
  const t = text.trim();
  if (t.length > 50 && JWT_RE.test(t)) return "JWT";
  if (t.startsWith("AKIA") && t.length === 20) return "AWS";
  if ((t.startsWith("ghp_") || t.startsWith("github_pat_")) && t.length > 30) return "GitHub";
  if (t.length > 30 && t.length % 4 === 0 && !/\s/.test(t) && BASE64_RE.test(t)) return "Base64";
  return "密钥";
}

/**
 * 脱敏显示：保留前 keep 个字符，其余以 • 遮罩。
 * 遮罩长度与实际长度弱相关（12~40），既给体量感又不泄露精确长度；
 * 文本本身不超过 keep 时原样返回（短文本遮罩无意义）。
 */
export function maskSecretText(text: string, keep = 8): string {
  const t = text.trim();
  if (t.length <= keep) return t;
  const maskLen = Math.min(40, Math.max(12, Math.ceil(t.length / 4)));
  return t.slice(0, keep) + "•".repeat(maskLen);
}
