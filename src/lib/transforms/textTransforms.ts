/**
 * transforms/textTransforms.ts — 文本类变换（原右键「粘贴并变换」静态菜单迁入注册表）。
 *
 * 迁移背景：右键「粘贴并变换」子菜单曾把 6 个通用变换 + 子类型变换 + 正则规则全部平铺，
 * 条目膨胀。方案 B 把通用/子类型文本变换统一迁入注册表——菜单只留子类型快捷项 + 「更多变换…」，
 * 长尾全部进变换枢纽（带实时预览 / 选项 chip / 匹配度），与 SQL IN / INSERT 等同一数据源。
 *
 * detect() 依赖 contentType（= item.content_type，后端细分类：link/email/phone/color/
 * file_path/markdown/code/json/text…），与右键菜单的子类型判断同源，菜单与枢纽对
 * "这条内容是什么"保持一致。run() 逻辑从 Card.tsx handlePasteTransform 原样搬迁，
 * 复用既有纯函数（stripHtml / urlHostPath / detectColor / toHex…），保证行为不变。
 *
 * 图片 / 文件变换（md_image / img_base64 / file_*）依赖 item.content 且含异步读取，
 * 不适配注册表同步 run(text) 模型，保留在 Card.tsx，不在此处。
 */

import { stripHtml as stripHtmlUtil } from "@/lib/utils";
import { detectColor, toHex, toRgb, toHsl, type ParsedColor } from "@/lib/color";
import { isCodeLike } from "@/lib/contentTypes";
import type { Transform, TransformContext, TransformResult } from "./types";

/** 通用变换基线分：任何非空文本都适用，但排在专业变换之后 */
const BASE = 0.25;

/** 非空文本返回 score，空文本返回 0（空内容不进枢纽） */
function base(ctx: TransformContext, score: number): number {
  const empty = ctx.features ? ctx.features.stats.isEmpty : !ctx.text.trim();
  return empty ? 0 : score;
}

/** 命中指定 contentType 返回 score，否则 0 */
function forType(ctx: TransformContext, type: string, score: number): number {
  return ctx.contentType === type ? base(ctx, score) : 0;
}

/** 纯文本 → 文本 的 run 包装 */
function ok(output: string): TransformResult {
  return { ok: true, output };
}

// ============ 通用文本变换（任何文本可用，基线分） ============

const upper: Transform = {
  id: "upper",
  label: "大写",
  description: "全部转为大写字母",
  icon: "case-upper",
  group: "text",
  detect: (ctx) => base(ctx, 0.1),
  run: (t) => ok(t.toUpperCase()),
};

const lower: Transform = {
  id: "lower",
  label: "小写",
  description: "全部转为小写字母",
  icon: "case-lower",
  group: "text",
  detect: (ctx) => base(ctx, 0.1),
  run: (t) => ok(t.toLowerCase()),
};

const strip: Transform = {
  id: "strip",
  label: "去空白",
  description: "去除首尾空白字符",
  icon: "eraser",
  group: "text",
  // 首尾确有空白时更相关
  detect: (ctx) => {
    const hasEdge = ctx.features ? ctx.features.stats.hasEdgeWhitespace : /^\s|\s$/.test(ctx.text);
    return base(ctx, hasEdge ? 0.5 : BASE);
  },
  run: (t) => ok(t.replace(/^\s+|\s+$/g, "")),
};

const stripLines: Transform = {
  id: "strip_lines",
  label: "去空行",
  description: "删除所有空白行",
  icon: "pilcrow",
  group: "text",
  // 多行时更相关
  detect: (ctx) => {
    const multiline = ctx.features ? ctx.features.stats.isMultiline : ctx.text.includes("\n");
    return base(ctx, multiline ? 0.45 : BASE);
  },
  run: (t) => ok(t.split("\n").filter((l) => l.trim()).join("\n")),
};

const stripHtml: Transform = {
  id: "strip_html",
  label: "剥离 HTML 标签",
  description: "移除标签，保留纯文本",
  icon: "remove-formatting",
  group: "text",
  // 确含 HTML 标签时高度相关
  detect: (ctx) => {
    const hasHtml = ctx.features ? ctx.features.stats.hasHtml : /<[a-z][\s\S]*>/i.test(ctx.text);
    return base(ctx, hasHtml ? 0.7 : BASE);
  },
  run: (t) => ok(stripHtmlUtil(t)),
};

// ============ 链接 / 邮箱 / 电话（web 类） ============

const mdLink: Transform = {
  id: "md_link",
  label: "Markdown 链接",
  description: "转为 [标题](地址) 格式",
  icon: "link",
  group: "web",
  detect: (ctx) =>
    ctx.contentType === "link" ? base(ctx, 0.85) : forType(ctx, "markdown", 0.4),
  run: (t) => ok(`[${t.slice(0, 30)}](${t})`),
};

// ============ 代码 / Markdown ============

const codeBlock: Transform = {
  id: "code_block",
  label: "代码块",
  description: "用 ``` 围栏包裹",
  icon: "code",
  group: "text",
  detect: (ctx) =>
    isCodeLike(ctx.contentType) ? base(ctx, 0.7) : forType(ctx, "markdown", 0.5),
  run: (t) => ok("```\n" + t + "\n```"),
};

// ============ 颜色（三个输出格式，各自独立卡片） ============

function colorRun(fmt: (c: ParsedColor) => string) {
  return (t: string): TransformResult => {
    const parsed = detectColor(t.trim());
    if (!parsed) return { ok: false, message: "未识别到颜色" };
    return ok(fmt(parsed));
  };
}

const colorHex: Transform = {
  id: "color_hex",
  label: "HEX",
  description: "转为 #RRGGBB 十六进制",
  icon: "hash",
  group: "text",
  detect: (ctx) => (ctx.contentType === "color" && detectColor(ctx.text.trim()) ? BASE + 0.65 : 0),
  run: colorRun(toHex),
};

const colorRgb: Transform = {
  id: "color_rgb",
  label: "RGB",
  description: "转为 rgb(r, g, b)",
  icon: "palette",
  group: "text",
  detect: (ctx) => (ctx.contentType === "color" && detectColor(ctx.text.trim()) ? BASE + 0.65 : 0),
  run: colorRun(toRgb),
};

const colorHsl: Transform = {
  id: "color_hsl",
  label: "HSL",
  description: "转为 hsl(h, s%, l%)",
  icon: "palette",
  group: "text",
  detect: (ctx) => (ctx.contentType === "color" && detectColor(ctx.text.trim()) ? BASE + 0.65 : 0),
  run: colorRun(toHsl),
};

// ============ 路径（文本型 file_path） ============

const pathBslash: Transform = {
  id: "path_bslash",
  label: "反斜杠路径",
  description: "统一为 Windows 风格 \\",
  icon: "folder",
  group: "text",
  detect: (ctx) => forType(ctx, "file_path", 0.8),
  run: (t) => ok(t.replace(/\//g, "\\")),
};

const pathFslash: Transform = {
  id: "path_fslash",
  label: "正斜杠路径",
  description: "统一为 POSIX 风格 /",
  icon: "folder",
  group: "text",
  detect: (ctx) => forType(ctx, "file_path", 0.8),
  run: (t) => ok(t.replace(/\\/g, "/")),
};

const pathName: Transform = {
  id: "path_name",
  label: "文件名",
  description: "只保留最后的文件 / 目录名",
  icon: "file-text",
  group: "text",
  detect: (ctx) => forType(ctx, "file_path", 0.8),
  run: (t) => ok(t.split(/[/\\]/).pop() || t),
};

/** 全部文本变换（供 index.ts 批量注册） */
export const textTransforms: Transform[] = [
  upper, lower, strip, stripLines, stripHtml,
  mdLink, codeBlock,
  colorHex, colorRgb, colorHsl,
  pathBslash, pathFslash, pathName,
];
