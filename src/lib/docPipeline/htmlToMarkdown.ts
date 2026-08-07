/**
 * docPipeline/htmlToMarkdown.ts — HTML → GFM Markdown（turndown + Joplin GFM 插件）。
 *
 * 流程：先过 sanitizeDocHtml（白名单清洗 + mso 剥离）→ turndown 转换。
 * GFM 插件提供表格/删除线/任务列表；自定义规则处理 Office mso 残留。
 */

import TurndownService from "turndown";
import { gfm } from "@joplin/turndown-plugin-gfm";
import { sanitizeDocHtml } from "./sanitizeDoc";

/** turndown 单例（规则注册一次，stateless 复用） */
let service: TurndownService | null = null;

function getService(): TurndownService {
  if (service) return service;
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
  });
  td.use(gfm);

  // mso 样式残留的 span/div 剥成纯内容（Word/Excel CF_HTML 大量携带）
  td.addRule("stripMsoSpans", {
    filter: (node) => {
      if (node.nodeName !== "SPAN" && node.nodeName !== "DIV") return false;
      const style = node.getAttribute("style") || "";
      const cls = node.getAttribute("class") || "";
      return /mso-/.test(style) || /mso/.test(cls);
    },
    replacement: (content) => content,
  });

  // Office 残留的 <!--[if ...]> 条件注释已被 DOMParser 剥掉，无需额外处理
  service = td;
  return td;
}

/** HTML → GFM Markdown。输入来自 CF_HTML 片段（doc/rich 条目的 content 字段）。 */
export function htmlToMarkdown(html: string): string {
  const sanitized = sanitizeDocHtml(html);
  return getService().turndown(sanitized).trim();
}
