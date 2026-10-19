/**
 * 导出用的 Markdown 渲染管线 —— 与预览**同源但独立**。
 *
 * 为什么不直接抓预览容器的 innerHTML：
 * - 高亮（hljs）与 mermaid 都是在 effect 里后置操作真实 DOM 的，导出时得等它们渲染完，
 *   而「等多久」没有确定答案（mermaid 是异步 + 依赖图复杂度）；
 * - 预览可能根本没挂载（用户只开了编辑态）。
 *
 * 所以这里重跑一遍渲染，但走的是官方推荐的确定性接口：
 * - 代码块：`hljs.highlight(code, {language})` 直接产出高亮字符串；
 * - 流程图：`mermaid.render(id, src)` 直接返回 svg 字符串（mermaid 官方文档与 mermaid-cli
 *   PR#536 都推荐它；`mermaid.run()` 要先过一遍 HTML，会吃掉换行导致 classDiagram 报错）。
 */
import { Marked, type Tokens } from "marked";
import DOMPurify from "dompurify";
import { invoke } from "@tauri-apps/api/core";
import { transformAlerts } from "./alerts";
import { FORM_SUGAR_EXT } from "./formSugar";
import { ensureFieldNames, type FieldInfo } from "./formFields";
import { escapeHtml } from "./html";
import { resolveLocalPath } from "./imageSrc";
import { headingHtml, resetHeadingSlugState } from "./headingAnchor";
import { mapMermaidTheme } from "@/lib/mermaidBlock";

export interface ExportRenderOptions {
  baseDir?: string | null;
  /** 当前主题名（决定 hljs 配色与 mermaid 主题） */
  theme?: string;
}

export interface ExportRenderResult {
  /** 已 sanitize / 图片已内联 / 字段已补 name 的正文 */
  html: string;
  fields: FieldInfo[];
  warnings: string[];
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

/** 单张图超过这个体积就不内联（base64 会再胖 1/3，且后端本身有 20MB 上限） */
const MAX_INLINE_BYTES = 8 * 1024 * 1024;

/** 一张待内联的本地图：占位串 ↔ 真实路径 ↔ 原 src（读取失败时退回原 src） */
interface InlineJob {
  token: string;
  path: string;
  original: string;
}

function extOf(path: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(path);
  return (m?.[1] ?? "").toLowerCase();
}

/** 判断一段文本里是否真的会出现代码块 / mermaid（决定要不要为它俩加载大包） */
function hasFence(text: string): { code: boolean; mermaid: boolean } {
  const mermaid = /^[ \t]*```[ \t]*mermaid\b/im.test(text);
  const code = /^[ \t]*```/m.test(text);
  return { code, mermaid };
}

async function loadHighlighter(): Promise<((code: string, lang: string) => string) | null> {
  try {
    const mod = await import("highlight.js/lib/common");
    const hljs = mod.default;
    return (code: string, lang: string) => {
      try {
        if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
        return escapeHtml(code);
      } catch {
        return escapeHtml(code);
      }
    };
  } catch {
    return null;
  }
}

/**
 * 消毒**之前**把本地图片路径换成占位符。
 *
 * 为什么必须这一步：DOMPurify 的默认 URI 白名单不认 Windows 盘符，`C:/a/b.png`
 * 会被整个剥掉 src（预览侧靠先转成 `asset://` 绕开，导出要的是原路径所以不能转）。
 * 换成相对形式的占位串能通过白名单，消毒后再把真实数据塞回去。
 */
function markLocalImages(
  html: string,
  baseDir: string | null | undefined,
): { html: string; jobs: InlineJob[] } {
  const jobs: InlineJob[] = [];
  const seen = new Map<string, string>();

  const out = html.replace(
    /(<img\b[^>]*?\bsrc\s*=\s*")([^"]*)(")/gi,
    (whole, pre: string, src: string, post: string) => {
      const local = resolveLocalPath(src, baseDir);
      if (!local) return whole; // 网络图 / data: / asset: 原样保留
      const hit = seen.get(local);
      if (hit) return `${pre}${hit}${post}`;
      const token = `./__ppimg${jobs.length}__`;
      jobs.push({ token, path: local, original: src });
      seen.set(local, token);
      return `${pre}${token}${post}`;
    },
  );
  return { html: out, jobs };
}

/** 并发 4 读盘：一次几十张全并发会让 Rust 侧排队，收益又不明显 */
async function runJobs(jobs: InlineJob[], warnings: string[]): Promise<Map<string, string>> {
  const cache = new Map<string, string>();
  const queue = jobs.map((job) => async () => {
    const mime = MIME_BY_EXT[extOf(job.path)];
    if (!mime) return;
    try {
      const b64 = await invoke<string>("read_file_as_base64", { path: job.path });
      if (!b64) return;
      // base64 长度 ≈ 4/3 原始字节；超限的图不内联，宁可留原路径也不让文件爆掉
      if (b64.length * 0.75 > MAX_INLINE_BYTES) {
        warnings.push(`图片过大未内联：${job.path}`);
        return;
      }
      cache.set(job.token, `data:${mime};base64,${b64}`);
    } catch {
      warnings.push(`图片读取失败，已保留原路径：${job.path}`);
    }
  });
  const pool = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) await queue.shift()!();
  });
  await Promise.all(pool);
  return cache;
}

/** 把占位符换回 data URI；读取失败的换回**原路径**（至少还能看出是哪张图） */
function applyInlineJobs(
  html: string,
  jobs: InlineJob[],
  cache: Map<string, string>,
): string {
  if (jobs.length === 0) return html;
  return html.replace(
    /(<img\b[^>]*?\bsrc\s*=\s*")([^"]*)(")/gi,
    (whole, pre: string, src: string, post: string) => {
      const job = jobs.find((j) => j.token === src);
      if (!job) return whole;
      return `${pre}${cache.get(job.token) ?? job.original}${post}`;
    },
  );
}

/** 把占位块逐个换成 mermaid 渲染出的 svg；失败就退化为源码块（与预览的失败态一致） */
async function renderMermaidBlocks(
  html: string,
  sources: string[],
  theme: string,
  warnings: string[],
): Promise<string> {
  if (sources.length === 0) return html;
  let out = html;
  try {
    const mod = await import("mermaid");
    const mermaid = mod.default;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: mapMermaidTheme(theme),
    });
    for (let i = 0; i < sources.length; i += 1) {
      const placeholder = `<div class="md-codeblock-mermaid" data-pp-mmd="${i}"><div class="md-mermaid-body"></div></div>`;
      if (!out.includes(placeholder)) continue;
      try {
        const { svg } = await mermaid.render(`pp-mmd-${i}-${Date.now()}`, sources[i]);
        // 函数替换：字符串 replacement 会把 `$&`/`$'`/`` $` `` 当 Replace Pattern 解释，
        // 图表标签里出现这类序列会确定性改写导出产物
        out = out.replace(placeholder, () =>
          `<div class="md-codeblock-mermaid"><div class="md-mermaid-body">${svg}</div></div>`,
        );
      } catch {
        out = out.replace(
          placeholder,
          () =>
            `<div class="md-codeblock-mermaid md-mermaid-error">` +
            `<pre class="md-mermaid-raw"><code>${escapeHtml(sources[i])}</code></pre></div>`,
        );
        warnings.push(`第 ${i + 1} 个图表无法渲染，已保留源码`);
      }
    }
  } catch {
    warnings.push("流程图组件加载失败，已保留源码");
  }
  return out;
}

/**
 * 渲染出可导出的正文 HTML。
 *
 * 顺序上有三处不能挪：
 * ① 图片内联必须在 sanitize **之前**——DOMPurify 会把 `C:/...` 当成不安全协议剥掉 src；
 * ② mermaid 替换必须在 sanitize **之后**——mermaid 产出的 svg 里有 foreignObject/style，
 *    再走一遍消毒会被削掉，图就残了（它本身来自受控库，不是用户输入）；
 * ③ 字段补 name 放最后，保证顺序就是文档顺序。
 */
export async function renderMarkdownForExport(
  text: string,
  opts: ExportRenderOptions = {},
): Promise<ExportRenderResult> {
  const { baseDir = null, theme = "ocean" } = opts;
  const warnings: string[] = [];
  const fences = hasFence(text);

  const mermaidSources: string[] = [];
  const hljs = fences.code ? await loadHighlighter() : null;
  if (fences.code && !hljs) warnings.push("代码高亮组件加载失败，代码块以纯文本导出");

  // breaks 必须与预览（renderHtml.ts 全局 marked）同值：导出目标是「预览里什么样，
  // 导出就是什么样」，单换行少了 <br> 会把多行段落合并成一行。
  const instance = new Marked({ gfm: true, breaks: true });
  instance.use(FORM_SUGAR_EXT);
  instance.use({
    renderer: {
      /**
       * 任务列表勾选框打 `data-pp-task`：它是**正文结构**（勾了表示「这项做完了」），
       * 不是表单字段。
       *
       * 不打这个标记会怎样：`ensureFieldNames` 会把它当无名控件补成 `__f0`，
       * 于是「已勾选状态」混进表单值里——而这个名字是按序号生成的，正文多插一项
       * 后面全部错位，上次填的值会挂到别的项上。导出侧没有写回源文的通道，
       * 所以直接保持 disabled。
       */
      checkbox({ checked }: Tokens.Checkbox): string {
        return `<input ${checked ? 'checked="" ' : ""}disabled="" type="checkbox" data-pp-task="1"> `;
      },
      code({ text: code, lang }: Tokens.Code): string {
        const language = (lang || "").trim().split(/\s+/)[0].toLowerCase();
        if (language === "mermaid") {
          const idx = mermaidSources.length;
          mermaidSources.push(code);
          // 占位必须是唯一串：后面按它做替换，替换失败就说明结构变了
          return `<div class="md-codeblock-mermaid" data-pp-mmd="${idx}"><div class="md-mermaid-body"></div></div>`;
        }
        const langLabel = language ? escapeHtml(language) : "text";
        const body = hljs ? hljs(code, language) : escapeHtml(code);
        // 导出文件里不放「复制」按钮：它绑的是预览的点击委托，导出的页面没有那条通道
        return (
          `<div class="md-codeblock"><div class="md-codehead">` +
          `<span class="md-wdot md-wdot-r"></span>` +
          `<span class="md-wdot md-wdot-y"></span>` +
          `<span class="md-wdot md-wdot-g"></span>` +
          `<span class="md-langtab">${langLabel}</span>` +
          `</div>` +
          `<pre><code class="hljs${language ? ` language-${escapeHtml(language)}` : ""}">${body}</code></pre>` +
          `</div>`
        );
      },
      heading(this: unknown, token: Tokens.Heading): string {
        const parser = (this as { parser?: { parseInline: (t: Tokens.Generic[]) => string } }).parser;
        const inner = parser?.parseInline
          ? parser.parseInline(token.tokens ?? [])
          : escapeHtml(token.text || "");
        const plain = (token.text || "")
          .replace(/[*_`~]/g, "")
          .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
          .trim();
        return headingHtml(token.depth, inner, plain);
      },
    },
  });

  // 标题 slug 计数必须每次归零，否则同一文档导出两次会得到 标题-1
  resetHeadingSlugState();

  let html: string;
  try {
    html = transformAlerts(instance.parse(text) as string);
  } catch {
    return { html: "", fields: [], warnings: ["解析失败：文档可能包含无法解析的结构"] };
  }
  if (!html.trim()) {
    return { html: "", fields: [], warnings: ["文档是空的，没有可导出的内容"] };
  }

  // 图片占位必须在消毒前打（见 markLocalImages 注释）
  const marked = markLocalImages(html, baseDir);
  html = marked.html;

  html = DOMPurify.sanitize(html, {
    ADD_TAGS: ["input", "textarea", "select", "option", "label", "details", "summary", "button"],
    ADD_ATTR: [
      "name",
      "placeholder",
      "value",
      "rows",
      "cols",
      "type",
      "checked",
      "disabled",
      "selected",
      "multiple",
      "min",
      "max",
      "step",
      "required",
      "readonly",
      "colspan",
      "rowspan",
      "align",
      "open",
      "data-pp-mmd",
      "data-task-i",
    ],
    // 表单能往任意地址发数据 = 把用户笔记变成钓鱼页。这三个属性必须剥掉。
    FORBID_ATTR: ["action", "method", "formaction"],
    ALLOW_DATA_ATTR: true,
  });

  const cache = await runJobs(marked.jobs, warnings);
  html = applyInlineJobs(html, marked.jobs, cache);
  html = await renderMermaidBlocks(html, mermaidSources, theme, warnings);

  const fields = ensureFieldNames(html);
  return { html: fields.html, fields: fields.fields, warnings };
}
