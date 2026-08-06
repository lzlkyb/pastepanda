/**
 * transforms/codecTransforms.ts — 编解码工具组。
 *
 * Base64 / URL / Unicode / HTML 实体 / JWT / Unix 时间戳 的编解码变换。
 * 全部为纯前端同步逻辑，注册到变换枢纽后自动按匹配度推荐。
 */

import type { Transform, TransformContext, TransformResult } from "./types";

const BASE = 0.2;

function ok(output: string, meta?: TransformResult["meta"]): TransformResult {
  return { ok: true, output, meta };
}

function fail(message: string): TransformResult {
  return { ok: false, message };
}

function nonEmpty(ctx: TransformContext, score: number): number {
  return ctx.text.trim() ? score : 0;
}

// ============ Base64 ============

const base64Encode: Transform = {
  id: "base64_encode",
  label: "Base64 编码",
  description: "将文本编码为 Base64",
  icon: "lock",
  group: "web",
  detect: (ctx) => nonEmpty(ctx, BASE),
  run: (t) => {
    try {
      // 支持中文：先 UTF-8 编码再 Base64
      const bytes = new TextEncoder().encode(t);
      let binary = "";
      bytes.forEach((b) => (binary += String.fromCharCode(b)));
      return ok(btoa(binary));
    } catch (e) {
      return fail(`Base64 编码失败: ${e}`);
    }
  },
};

const base64Decode: Transform = {
  id: "base64_decode",
  label: "Base64 解码",
  description: "将 Base64 解码为文本",
  icon: "unlock",
  group: "web",
  detect: (ctx) => {
    // 优先读预分析特征
    if (ctx.features?.base64) {
      return ctx.features.base64.valid ? 0.85 : 0;
    }
    const t = ctx.text.trim();
    if (/^[A-Za-z0-9+/=_\-\s]+$/.test(t) && t.length >= 8) {
      return 0.85;
    }
    return 0;
  },
  run: (t) => {
    try {
      const cleaned = t.replace(/\s/g, "");
      // Base64URL → 标准 Base64
      const std = cleaned.replace(/-/g, "+").replace(/_/g, "/");
      // 补齐 padding
      const padLen = (4 - (std.length % 4)) % 4;
      const padded = std + "=".repeat(padLen);
      const binary = atob(padded);
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      return ok(new TextDecoder().decode(bytes));
    } catch {
      return fail("不是有效的 Base64 字符串");
    }
  },
};

// ============ URL ============

const urlEncode: Transform = {
  id: "url_encode",
  label: "URL 编码",
  description: "将文本进行 URL 编码（encodeURIComponent）",
  icon: "link",
  group: "web",
  detect: (ctx) => nonEmpty(ctx, BASE),
  run: (t) => ok(encodeURIComponent(t)),
};

const urlDecode: Transform = {
  id: "url_decode",
  label: "URL 解码",
  description: "将 URL 编码还原为文本",
  icon: "unlink",
  group: "web",
  detect: (ctx) => {
    if (ctx.features?.urlEncoded) {
      return ctx.features.urlEncoded.hasPattern ? 0.85 : 0;
    }
    if (/%[0-9A-Fa-f]{2}/.test(ctx.text)) return 0.85;
    if (ctx.text.includes("+") && /\w\+\w/.test(ctx.text)) return 0.5;
    return 0;
  },
  run: (t) => {
    try {
      return ok(decodeURIComponent(t.replace(/\+/g, " ")));
    } catch {
      return fail("URL 解码失败：包含无效的 % 序列");
    }
  },
};

// ============ Unicode ============

const unicodeEncode: Transform = {
  id: "unicode_encode",
  label: "Unicode 编码",
  description: "将非 ASCII 字符转为 \\uXXXX 形式",
  icon: "code",
  group: "web",
  detect: (ctx) => {
    // 包含非 ASCII 字符时更相关（\x00 只是 ASCII 区间下界，不是要匹配控制字符）
    // eslint-disable-next-line no-control-regex
    return /[^\x00-\x7F]/.test(ctx.text) ? 0.6 : nonEmpty(ctx, BASE);
  },
  run: (t) => {
    // eslint-disable-next-line no-control-regex
    const encoded = t.replace(/[^\x00-\x7F]/g, (ch) => {
      const code = ch.codePointAt(0)!;
      if (code > 0xffff) {
        // 代理对：\u{XXXXX} 形式
        return `\\u{${code.toString(16).toUpperCase()}}`;
      }
      return `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
    });
    return ok(encoded);
  },
};

const unicodeDecode: Transform = {
  id: "unicode_decode",
  label: "Unicode 解码",
  description: "将 \\uXXXX 转义还原为字符",
  icon: "text",
  group: "web",
  detect: (ctx) => {
    if (/\\u[0-9A-Fa-f]{4}/.test(ctx.text)) return 0.9;
    if (/\\u\{[0-9A-Fa-f]+\}/.test(ctx.text)) return 0.9;
    return 0;
  },
  run: (t) => {
    try {
      // 先处理 \u{XXXXX} 形式
      let result = t.replace(/\\u\{([0-9A-Fa-f]+)\}/g, (_, hex) =>
        String.fromCodePoint(parseInt(hex, 16))
      );
      // 再处理 \uXXXX 形式
      result = result.replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16))
      );
      return ok(result);
    } catch {
      return fail("Unicode 解码失败：包含无效的转义序列");
    }
  },
};

// ============ HTML 实体 ============

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
  "&apos;": "'", "&nbsp;": "\u00A0", "&copy;": "\u00A9",
  "&reg;": "\u00AE", "&trade;": "\u2122", "&mdash;": "\u2014",
  "&ndash;": "\u2013", "&hellip;": "\u2026", "&laquo;": "\u00AB",
  "&raquo;": "\u00BB", "&ldquo;": "\u201C", "&rdquo;": "\u201D",
  "&lsquo;": "\u2018", "&rsquo;": "\u2019",
};

const REVERSE_ENTITIES: Record<string, string> = Object.fromEntries(
  Object.entries(HTML_ENTITIES).map(([k, v]) => [v, k])
);

const htmlEncode: Transform = {
  id: "html_encode",
  label: "HTML 转义",
  description: "将特殊字符转为 HTML 实体（&amp; &lt; 等）",
  icon: "code",
  group: "web",
  detect: (ctx) => {
    // 包含需要转义的字符
    return /[<>&"']/.test(ctx.text) ? 0.5 : nonEmpty(ctx, BASE);
  },
  run: (t) => {
    const result = t.replace(/[&<>"']/g, (ch) => REVERSE_ENTITIES[ch] || `&#${ch.charCodeAt(0)};`);
    return ok(result);
  },
};

const htmlDecode: Transform = {
  id: "html_decode",
  label: "HTML 反转义",
  description: "将 HTML 实体还原为字符",
  icon: "text",
  group: "web",
  detect: (ctx) => {
    if (/&[a-zA-Z]+;|&#\d+;|&#x[0-9A-Fa-f]+;/.test(ctx.text)) return 0.9;
    return 0;
  },
  run: (t) => {
    const result = t
      .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
      .replace(/&[a-zA-Z]+;/g, (entity) => HTML_ENTITIES[entity] ?? entity);
    return ok(result);
  },
};

// ============ JWT ============

const jwtDecode: Transform = {
  id: "jwt_decode",
  label: "JWT 解析",
  description: "解码 JWT 的 Header 和 Payload（不验证签名）",
  icon: "key",
  group: "web",
  detect: (ctx) => {
    if (ctx.features?.jwt) return ctx.features.jwt.valid ? 0.95 : 0;
    const t = ctx.text.trim();
    if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(t)) return 0.95;
    return 0;
  },
  run: (t) => {
    try {
      const parts = t.trim().split(".");
      if (parts.length < 2) return fail("不是有效的 JWT 格式");

      const decodeB64Url = (s: string): string => {
        const padded = s.replace(/-/g, "+").replace(/_/g, "/");
        const binary = atob(padded);
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        return new TextDecoder().decode(bytes);
      };

      const header = JSON.parse(decodeB64Url(parts[0]));
      const payload = JSON.parse(decodeB64Url(parts[1]));

      // 格式化时间戳字段
      const timeFields = ["iat", "exp", "nbf"];
      for (const f of timeFields) {
        if (typeof payload[f] === "number") {
          payload[`${f}_readable`] = new Date(payload[f] * 1000).toISOString();
        }
      }

      const output = [
        "=== Header ===",
        JSON.stringify(header, null, 2),
        "",
        "=== Payload ===",
        JSON.stringify(payload, null, 2),
        "",
        `=== Signature === (${parts[2] ? "存在" : "空"})`,
      ].join("\n");

      return ok(output, { count: Object.keys(payload).length });
    } catch {
      return fail("JWT 解码失败：Header 或 Payload 不是有效的 Base64/JSON");
    }
  },
};

// ============ Unix 时间戳 ============

const timestampToDate: Transform = {
  id: "timestamp_to_date",
  label: "时间戳 → 日期",
  description: "将 Unix 时间戳（秒/毫秒）转为可读日期",
  icon: "clock",
  group: "text",
  detect: (ctx) => {
    if (ctx.features?.timestamp) return ctx.features.timestamp.isTimestamp ? 0.9 : 0;
    const t = ctx.text.trim();
    if (/^\d{10}$/.test(t)) return 0.9;
    if (/^\d{13}$/.test(t)) return 0.9;
    return 0;
  },
  run: (t) => {
    const num = parseInt(t.trim(), 10);
    if (isNaN(num)) return fail("不是有效的数字");
    // 10 位 = 秒，13 位 = 毫秒
    const ms = t.trim().length <= 10 ? num * 1000 : num;
    const d = new Date(ms);
    if (isNaN(d.getTime())) return fail("时间戳超出有效范围");

    const output = [
      `UTC:   ${d.toISOString()}`,
      `本地:  ${d.toLocaleString("zh-CN", { hour12: false })}`,
      `秒:    ${Math.floor(ms / 1000)}`,
      `毫秒:  ${ms}`,
    ].join("\n");
    return ok(output);
  },
};

const dateToTimestamp: Transform = {
  id: "date_to_timestamp",
  label: "日期 → 时间戳",
  description: "将日期字符串转为 Unix 时间戳",
  icon: "clock",
  group: "text",
  detect: (ctx) => {
    if (ctx.features?.date) return ctx.features.date.looksLikeDate ? 0.8 : 0;
    const t = ctx.text.trim();
    if (/^\d{4}[-/]\d{2}[-/]\d{2}/.test(t)) return 0.8;
    return 0;
  },
  run: (t) => {
    const d = new Date(t.trim());
    if (isNaN(d.getTime())) return fail("无法解析日期格式");
    const output = [
      `秒:    ${Math.floor(d.getTime() / 1000)}`,
      `毫秒:  ${d.getTime()}`,
      `ISO:   ${d.toISOString()}`,
    ].join("\n");
    return ok(output);
  },
};

// ============ 导出 ============

export const codecTransforms: Transform[] = [
  base64Encode, base64Decode,
  urlEncode, urlDecode,
  unicodeEncode, unicodeDecode,
  htmlEncode, htmlDecode,
  jwtDecode,
  timestampToDate, dateToTimestamp,
];
