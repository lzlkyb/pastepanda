/**
 * pasteTransform.ts — 粘贴变换纯逻辑（从 Card.tsx handlePasteTransform 提取）
 * 22 种变换，输入 (text, content, transform) → 输出变换后文本
 * 纯函数，无副作用（不调用 pasteText / invoke），便于单元测试和复用
 */
import { detectColor, toHex, toRgb, toHsl } from "@/lib/color";
import { urlHostPath } from "@/lib/url";
// 路径解析已收口到 lib/utils（规则 #11），不再在本文件里维护一份
import { parseFilePaths } from "@/lib/utils";

/** 去除 HTML 标签 */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

export interface TransformInput {
  text: string;
  content: string;
}

/**
 * 执行粘贴变换（纯函数）
 * @returns 变换后的文本；如果变换不适用（如 color 解析失败），返回原文
 */
export function applyPasteTransform(input: TransformInput, transform: string): string {
  const text = input.text || "";
  const content = input.content || "";

  switch (transform) {
    // === 文本通用变换 ===
    case "upper": return text.toUpperCase();
    case "lower": return text.toLowerCase();
    case "strip": return text.replace(/^\s+|\s+$/g, "");
    case "strip_lines": return text.split("\n").filter((l) => l.trim()).join("\n");
    case "quote": return `"${text}"`;
    case "md_link": return `[${text.slice(0, 30)}](${text})`;
    case "strip_html": return stripHtml(text);

    // === 链接子类型 ===
    case "plain_url":
      return urlHostPath(text);

    // === 邮箱子类型 ===
    case "mailto": return `mailto:${text.trim()}`;

    // === 代码子类型 ===
    case "code_block": return "```\n" + text + "\n```";
    case "single_line": return text.split("\n").map((l) => l.trim()).join("; ");

    // === 电话子类型 ===
    case "tel": return `tel:${text.replace(/[- ]/g, "")}`;
    case "phone_cn": {
      const digits = text.replace(/[- ()（）+]/g, "");
      return digits.startsWith("86") ? `+${digits}` : `+86${digits}`;
    }

    // === 颜色子类型 ===
    case "color_hex": {
      const parsed = detectColor(text.trim());
      return parsed ? toHex(parsed) : text;
    }
    case "color_rgb": {
      const parsed = detectColor(text.trim());
      return parsed ? toRgb(parsed) : text;
    }
    case "color_hsl": {
      const parsed = detectColor(text.trim());
      return parsed ? toHsl(parsed) : text;
    }

    // === 图片类型 ===
    case "md_image": {
      const imgPath = content || text;
      return `![图片](${imgPath})`;
    }
    // img_base64 需要 invoke，不在此纯函数中处理

    // === 文件类型 ===
    case "file_name": {
      const files = parseFilePaths(content);
      return files.map((f) => f.split(/[/\\]/).pop() || f).join("\n");
    }
    case "file_dir": {
      const files = parseFilePaths(content);
      return files.map((f) => {
        const idx = Math.max(f.lastIndexOf("/"), f.lastIndexOf("\\"));
        return idx >= 0 ? f.slice(0, idx) : ".";
      }).join("\n");
    }
    case "file_bslash": {
      const files = parseFilePaths(content);
      return files.map((f) => f.replace(/\//g, "\\")).join("\n");
    }
    case "file_fslash": {
      const files = parseFilePaths(content);
      return files.map((f) => f.replace(/\\/g, "/")).join("\n");
    }
    case "file_list": {
      const files = parseFilePaths(content);
      return files.join("\n");
    }

    default: return text;
  }
}
