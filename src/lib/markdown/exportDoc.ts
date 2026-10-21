/**
 * 把「已渲染好的正文 + 已内联的样式 + 表单值」组装成一个可独立打开的 HTML 文件。
 *
 * 设计约束（都有实测或先例支撑）：
 * ① **单文件**：业务人员的场景是「收到一个文件 → 双击 → 看」。多带一个资源目录，
 *    在微信/邮件转发里丢图的概率远高于省下的那点体积。
 * ② **样式零漂移**：正文根节点带上 `MarkdownRenderer.module.css` 里 `.md` 的
 *    哈希类名，再把同一份 CSS 文本内联进来——排版与预览完全一致，不用维护第二套。
 * ③ **主题变量必须快照**：CSS 里全是 `var(--text-primary)` 这类引用。不把当前主题
 *    解析成 `:root{--x:具体值}` 写进去，文件到了别人电脑上就是透明/黑字。
 * ④ **脚本只在有交互时嵌**：纯阅读的导出不嵌任何 JS，攻击面最小。这里的「交互」
 *    指**可填字段**与**可勾的任务框**两类——任务勾选要记在本机、要能随「下载已填版本」
 *    带走，没有运行时就成了「能点却记不住」的假交互。
 * ⑤ **目录是结构不是交互**：`<details>` + `#锚点` 由浏览器原生行为完成折叠与跳转，
 *    不引入一行脚本，纯阅读导出仍然是零 JS。
 */
import { escapeHtml } from "./html";
import { serializeValues, type FieldInfo } from "./formFields";
import { buildTocHtml, collectHeadings } from "./exportToc";

export interface ExportTheme {
  /** data-theme 值（决定 hljs 配色与主题变量来源） */
  name: string;
  /** data-appearance（classic / modern） */
  appearance?: string | null;
  /** 已解析成具体值的 CSS 变量 */
  vars: Record<string, string>;
}

export interface ExportDocInput {
  title: string;
  /** 已 sanitize、图片已内联、字段已补 name 的正文 HTML */
  bodyHtml: string;
  /** 内联 CSS（含哈希类名的 module css + 代码高亮主题） */
  css: string;
  /** 正文根节点要带的类名（CSS Modules 的 `.md` 哈希值） */
  rootClass: string;
  theme: ExportTheme;
  docId: string;
  fields: FieldInfo[];
  values?: Record<string, unknown>;
  /** 页面底部署名信息 */
  sourceName?: string | null;
  exportedAt?: string;
  /** 内嵌的表单运行时脚本源码（为空则不嵌，导出文件退化为纯静态页） */
  runtimeJs?: string;
  /**
   * 正文里任务勾选框的数量（`- [ ]` 渲染出来的 `data-pp-task`）。
   *
   * 它决定要不要嵌运行时：勾选状态要存进 localStorage、要能随「下载已填版本」带走，
   * 那就必须有脚本。**没有表单字段但有任务框时同样要嵌** —— 早期实现把「有表单」
   * 当成唯一条件，于是纯清单文档的框能点却记不住，看着像"点了没用"。
   */
  taskCount?: number;
}

/** 导出页外壳样式。刻意只用主题变量：换成别的主题导出的文件配色也跟着对。 */
const SHELL_CSS = `
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--app-bg);color:var(--text-primary);
  font-family:"Segoe UI","Microsoft YaHei",system-ui,-apple-system,sans-serif;
  -webkit-font-smoothing:antialiased}
.pp-page{max-width:920px;margin:0 auto;padding:24px 24px 64px}
.pp-bar{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:10px;
  padding:9px 12px;margin:0 0 22px;border:1px solid var(--border-color);border-radius:10px;
  background:var(--card-bg);flex-wrap:wrap}
.pp-bar-title{font-size:13px;font-weight:600;margin-right:auto;min-width:0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pp-state{font-size:12px;color:var(--text-muted);white-space:nowrap}
.pp-state[data-warn="1"]{color:var(--danger)}
.pp-btn{font-size:12px;padding:5px 11px;border-radius:8px;cursor:pointer;
  border:1px solid var(--border-color);background:transparent;color:var(--text-primary);
  font-family:inherit;white-space:nowrap}
.pp-btn:hover{background:color-mix(in srgb, var(--accent) 10%, transparent);
  border-color:color-mix(in srgb, var(--accent) 36%, var(--border-color))}
.pp-btn-primary{border-color:transparent;
  background:color-mix(in srgb, var(--accent) 16%, transparent);color:var(--accent)}
.pp-btn-primary:hover{background:color-mix(in srgb, var(--accent) 24%, transparent)}
.pp-foot{margin-top:36px;padding-top:14px;border-top:1px solid var(--border-color);
  font-size:12px;color:var(--text-muted)}
.pp-toc{margin:0 0 22px;padding:10px 14px;border:1px solid var(--border-color);
  border-radius:10px;background:var(--card-bg);font-size:13px}
.pp-toc>summary{cursor:pointer;color:var(--text-muted);font-size:12px;
  list-style:none;user-select:none;padding:1px 0}
.pp-toc>summary::-webkit-details-marker{display:none}
.pp-toc>summary::before{content:"▸";display:inline-block;margin-right:8px;
  transition:transform .15s ease}
.pp-toc[open]>summary::before{transform:rotate(90deg)}
.pp-toc-list{list-style:none;margin:8px 0 2px;padding:0}
.pp-toc-i{margin:1px 0;line-height:1.5}
.pp-toc-i>a{display:block;padding:2px 8px;border-radius:8px;color:var(--text-primary);
  text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pp-toc-i>a:hover{background:color-mix(in srgb, var(--accent) 10%, transparent);
  color:var(--accent)}
.pp-toc-l2{padding-left:16px}
.pp-toc-l3{padding-left:32px}
.pp-toc-l4{padding-left:48px}
.pp-toc-l5{padding-left:64px}
.pp-toc-l6{padding-left:80px}
.pp-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);
  padding:8px 14px;border-radius:8px;font-size:12px;background:var(--card-bg);
  border:1px solid var(--border-color);color:var(--text-primary);opacity:0;
  transition:opacity .18s ease;pointer-events:none}
.pp-toast[data-on="1"]{opacity:1}
@media print{
  .pp-bar,.pp-foot,.pp-toast,.pp-toc{display:none}
  body{background:#fff}
  .pp-page{max-width:none;padding:0}
  a[href^="http"]::after{content:" (" attr(href) ")";font-size:11px;color:#555}
  pre,blockquote,table{break-inside:avoid}
}`;

/** 内联脚本里出现 `</script` 会提前闭合标签 —— 这是唯一必须转义的地方 */
export function escapeInlineScript(js: string): string {
  return js.replace(/<\/script/gi, "<\\/script");
}

/** 把主题变量序列化成 `:root{--x:val}`。值里的 `;` `}` 会破坏声明，直接丢弃。 */
export function cssVarsBlock(vars: Record<string, string>): string {
  const rows = Object.entries(vars)
    .filter(([k, v]) => k.startsWith("--") && v && !/[;}]/.test(v))
    .map(([k, v]) => `${k}:${v};`);
  return rows.length ? `:root{\n${rows.join("\n")}\n}` : "";
}

export function buildHtmlDocument(input: ExportDocInput): string {
  const {
    title,
    bodyHtml,
    css,
    rootClass,
    theme,
    docId,
    fields,
    values = {},
    sourceName,
    exportedAt = new Date().toISOString().slice(0, 10),
    runtimeJs,
  } = input;

  const hasField = fields.length > 0;
  const hasTasks = (input.taskCount ?? 0) > 0;
  // 有字段或任务框就要嵌运行时：任务勾选同样需要「记住 + 随文件带走」
  const hasForm = (hasField || hasTasks) && !!runtimeJs;
  const toc = buildTocHtml(collectHeadings(bodyHtml));
  const themeAttr = theme.appearance ? ` data-appearance="${escapeHtml(theme.appearance)}"` : "";

  const bar = hasForm
    ? `<div class="pp-bar">` +
      `<span class="pp-bar-title">${escapeHtml(title)}</span>` +
      `<span class="pp-state" id="pp-state">已就绪</span>` +
      // 「复制填写结果」只对表单字段有意义；纯清单文档没有可复制的键值
      (hasField ? `<button type="button" class="pp-btn" data-pp="copy">复制填写结果</button>` : "") +
      `<button type="button" class="pp-btn pp-btn-primary" data-pp="download">下载已填版本</button>` +
      `</div>`
    : "";

  const footNote = hasTasks
    ? " · 填写与勾选只保存在本机浏览器"
    : hasField
      ? " · 填写内容只保存在本机浏览器"
      : "";

  const foot = `<div class="pp-foot">${escapeHtml(title)} · ${escapeHtml(exportedAt)}${
    sourceName ? ` · 来源 ${escapeHtml(sourceName)}` : ""
  }${footNote}</div>`;

  const script = hasForm
    ? `<script id="pp-data" type="application/json">${serializeValues({
        docId,
        values,
      })}</script>` +
      `<script>${escapeInlineScript(runtimeJs as string)}</script>`
    : "";

  return `<!doctype html>
<html lang="zh-CN" data-theme="${escapeHtml(theme.name)}"${themeAttr}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="PastePanda">
<title>${escapeHtml(title)}</title>
<style>
${cssVarsBlock(theme.vars)}
${css}
${SHELL_CSS}
</style>
</head>
<body>
<div class="pp-page">
${bar}
${toc}
<div class="${rootClass}" data-pp-root="1">
${bodyHtml}
</div>
${foot}
</div>
<div class="pp-toast" id="pp-toast"></div>
${script}
</body>
</html>`;
}
