/**
 * transforms/docTransforms.ts — 文档内容处理变换（P2/P3）。
 *
 * 注册到变换枢纽后自动出现在右键「变换为…」与枢纽面板。
 * doc/rich 条目的 CF_HTML 片段经 TransformContext.html 与 opts.html 两条路径传入：
 * - detect(ctx)：读 ctx.html 判断是否适用；
 * - run(text, opts)：读 opts.html 取 HTML 输入（hub 传 { ...opts, html: item.content }）。
 *
 * 纯文本变换（PDF 断行修复）不依赖 html，走 text 通道。
 */

import type { Transform, TransformResult } from "./types";
import { sanitizeDocHtml, htmlToMarkdown, hasMergedCells, htmlTableToGfm, repairPdfText } from "@/lib/docPipeline";

const ok = (output: string): TransformResult => ({ ok: true, output });
const fail = (message: string): TransformResult => ({ ok: false, message });

/** 从 opts 取 HTML（hub 对 doc/rich 条目注入 opts.html） */
function htmlFromOpts(opts?: Record<string, unknown>): string {
  return (opts?.html as string) || "";
}

// ── 格式清洗：HTML → 白名单清洗后的干净 HTML（保留表格/链接/标题结构，删 mso/script/style）──
const cleanHtml: Transform = {
  id: "doc_clean_html",
  label: "格式清洗",
  description: "去样式噪声，保留表格/链接/标题结构",
  icon: "remove-formatting",
  group: "doc",
  detect: (ctx) => (ctx.html ? 0.8 : ctx.features?.stats.hasHtml ? 0.3 : 0),
  run: (_text, opts) => {
    const html = htmlFromOpts(opts);
    if (!html) return fail("无 HTML 片段");
    return ok(sanitizeDocHtml(html));
  },
};

// ── 转 Markdown：HTML → GFM Markdown（turndown + 表格/列表/链接）──
const toMarkdown: Transform = {
  id: "doc_to_markdown",
  label: "转 Markdown",
  description: "HTML → GFM Markdown（含表格/列表/链接）",
  icon: "file-text",
  group: "doc",
  detect: (ctx) => (ctx.html ? 0.85 : 0),
  run: (_text, opts) => {
    const html = htmlFromOpts(opts);
    if (!html) return fail("无 HTML 片段");
    return ok(htmlToMarkdown(html));
  },
};

// ── 表格 → GFM：HTML <table> → Markdown 表格（含合并单元格检测与降级）──
const tableToGfm: Transform = {
  id: "doc_table_to_gfm",
  label: "表格 → Markdown",
  description: "HTML 表格 → GFM 表格（合并单元格时降级）",
  icon: "table",
  group: "doc",
  detect: (ctx) => {
    if (!ctx.html) return 0;
    return /<table/i.test(ctx.html) ? 0.9 : 0;
  },
  run: (_text, opts) => {
    const html = htmlFromOpts(opts);
    if (!html) return fail("无 HTML 片段");
    if (hasMergedCells(html)) return fail("含合并单元格，无法转 GFM 表格（已保留原文）");
    const gfm = htmlTableToGfm(html);
    return gfm ? ok(gfm) : fail("未找到表格");
  },
};

// ── PDF 断行修复：纯文本启发式（合并硬换行/还原断词/修复连字）──
const pdfRepair: Transform = {
  id: "pdf_repair",
  label: "PDF 断行修复",
  description: "合并硬换行、还原断词、修复连字",
  icon: "eraser",
  group: "text",
  detect: (ctx) => (ctx.features?.pdfLike ? 0.7 : 0),
  run: (text) => ok(repairPdfText(text)),
};

export const docTransforms: Transform[] = [cleanHtml, toMarkdown, tableToGfm, pdfRepair];
