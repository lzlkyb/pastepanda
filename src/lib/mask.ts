/**
 * lib/mask.ts —— v6.4 B 粘贴脱敏：内容内嵌的敏感信息识别与替换。
 *
 * 覆盖五类（规则与 Rust content_classifier 对齐）：
 * 密钥（sk-/ghp_/github_pat_/AKIA/JWT）/ 手机号 / 邮箱 / 身份证 / IPv4。
 *
 * 设计：
 * - **保留可辨识前缀、遮罩主体**（手机 138****1234、邮箱 a***@b.com），
 *   既脱敏又让接收方知道"这是什么"；
 * - **只在预览后落盘**：变换面板先展示脱敏结果，用户确认复制/粘贴，
 *   避免把人名当密钥误伤（误伤 = 用户看到脱敏版自行判断）；
 * - 纯本地规则，零 AI 成本；`count` 供 detect 判定是否命中。
 */

export interface MaskResult {
  /** 脱敏后的文本 */
  text: string;
  /** 替换/遮罩的敏感片段数量 */
  count: number;
}

// 密钥 token（内容内嵌识别）：AI 服务商前缀 / GitHub / AWS / JWT
const SECRET_TOKEN_RE =
  /\b((?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}))\b/g;

/** 手机号：11 位，1 开头 + 3-9 */
const PHONE_RE = /(?<!\d)(1[3-9]\d{9})(?!\d)/g;

/** 邮箱：用户名（≥1 字符）+ @ + 域名（单字符用户名也脱敏，如 a***@b.com） */
const EMAIL_RE = /([A-Za-z0-9._%+-]{1,})@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/** 身份证：18 位，末位可为 X/x */
const SSN_RE = /(?<!\d)(\d{17}[\dXx])(?!\d)/g;

/** IPv4 */
const IPV4_RE = /(?<!\d)(\d{1,3}(?:\.\d{1,3}){3})(?!\d)/g;

/**
 * 对文本做内嵌脱敏。
 *
 * 替换顺序：IP → 手机 → 身份证 → 邮箱 → 密钥（互不重叠，顺序不影响结果，
 * 仅避免身份证与手机/邮箱正则交叉误匹配）。
 */
export function maskSensitiveText(text: string): MaskResult {
  let count = 0;

  // IPv4：全遮
  let out = text.replace(IPV4_RE, () => {
    count++;
    return "***.***.***.***";
  });

  // 手机号：138****1234
  out = out.replace(PHONE_RE, (m) => {
    count++;
    return m.slice(0, 3) + "****" + m.slice(7);
  });

  // 身份证：前 6 后 4
  out = out.replace(SSN_RE, (m) => {
    count++;
    return m.slice(0, 6) + "********" + m.slice(-4);
  });

  // 邮箱：a***@domain
  out = out.replace(EMAIL_RE, (_m, user: string, domain: string) => {
    count++;
    return `${user.slice(0, 2)}***@${domain}`;
  });

  // 密钥 token：保留前 4 位
  out = out.replace(SECRET_TOKEN_RE, (m) => {
    count++;
    return m.slice(0, 4) + "***";
  });

  return { text: out, count };
}
