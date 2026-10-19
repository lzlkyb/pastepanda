import { marked, type Tokens } from "marked";
import DOMPurify from "dompurify";
import { mermaidBlockHtml } from "@/lib/mermaidBlock";
import { escapeHtml } from "@/lib/markdown/html";
import {
  classifyImageSrc,
  imageMissingHtml,
  toAssetUrl,
} from "@/lib/markdown/imageSrc";
import {
  resetHeadingSlugState,
  headingHtml,
} from "@/lib/markdown/headingAnchor";
import { scanTaskItemsFromTokens } from "@/lib/markdown/tasks";
import { transformAlerts } from "@/lib/markdown/alerts";
import { FORM_SUGAR_EXT } from "@/lib/markdown/formSugar";

// ─── marked 全局配置（只执行一次）──────────────────────────
marked.setOptions({
  gfm: true,
  breaks: true,
});

// ─── 代码块渲染器：窗口彩点 + 语言页签 + 复制按钮 ─────────
// marked 输出的是原始 HTML 字符串，无法引用 CSS Modules 哈希类名，
// 故代码块外壳使用全局类名 md-code*（样式见 MarkdownRenderer.module.css 的 :global 段）。

export const COPY_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>';

export function currentTheme(): string {
  if (typeof document === "undefined") return "neutral";
  return document.documentElement.getAttribute("data-theme") || "neutral";
}

marked.use({
  renderer: {
    code({ text, lang }: Tokens.Code): string {
      const language = (lang || "").trim().split(/\s+/)[0].toLowerCase();
      const langLabel = language ? escapeHtml(language) : "text";
      if (language === "mermaid") return mermaidBlockHtml(text);
      return (
        `<div class="md-codeblock">` +
        `<div class="md-codehead">` +
        `<span class="md-wdot md-wdot-r"></span>` +
        `<span class="md-wdot md-wdot-y"></span>` +
        `<span class="md-wdot md-wdot-g"></span>` +
        `<span class="md-langtab">${langLabel}</span>` +
        `<button type="button" class="md-copybtn">${COPY_ICON} 复制</button>` +
        `</div>` +
        `<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ""}>${escapeHtml(text)}</code></pre>` +
        `</div>`
      );
    },
    /**
     * 标题注入 id + 可点「#」锚点。slug 与大纲 scanHeadings 同源。
     * `this.parser.parseInline` 保留行内格式；slug 用纯文本，避免 `**` 进 id。
     */
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

// ─── 行号模式：代码块按行包裹 / 解包（全局类 md-cl / md-cln / md-clc）───
// hljs 高亮完成后把 <code> 内容按 \n 拆成行结构以显示行号；
// 重新高亮前必须先解包——否则行号文本会混入 textContent 污染源码。

/** 将已包裹的行结构还原为纯文本（textContent 与包裹前逐字一致，保证重高亮幂等） */
export function unwrapCodeLines(code: HTMLElement): void {
  const rows = code.querySelectorAll(":scope > .md-cl");
  if (rows.length === 0) return;
  const lines = Array.from(rows).map((r) => r.querySelector(".md-clc")?.textContent ?? "");
  code.textContent = lines.join("\n");
}

/** 把高亮后的 <code> 内容按行拆为 md-cl 行（行号 md-cln + 内容 md-clc） */
export function wrapCodeLines(code: HTMLElement): void {
  if (code.querySelector(":scope > .md-cl")) return; // 已包裹（防御）
  if (!code.textContent) return; // 空代码块不包裹

  const makeRow = (num: number): HTMLElement => {
    const row = document.createElement("div");
    row.className = "md-cl";
    const ln = document.createElement("span");
    ln.className = "md-cln";
    ln.textContent = String(num);
    const lc = document.createElement("span");
    lc.className = "md-clc";
    row.append(ln, lc);
    return row;
  };

  const rows: HTMLElement[] = [];
  let row = makeRow(1);
  let count = 1;
  const content = () => row.lastElementChild as HTMLElement;

  // 深度遍历：文本节点按 \n 拆行；跨行元素（如多行注释 span）逐行克隆外壳包裹
  const walk = (node: Node, wrapper: HTMLElement | null): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const parts = (node.nodeValue ?? "").split("\n");
      parts.forEach((part, i) => {
        if (i > 0) {
          rows.push(row);
          count += 1;
          row = makeRow(count);
        }
        if (!part) return;
        if (wrapper) {
          const shell = wrapper.cloneNode(false) as HTMLElement;
          shell.textContent = part;
          content().appendChild(shell);
        } else {
          content().appendChild(document.createTextNode(part));
        }
      });
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      if ((el.textContent ?? "").includes("\n")) {
        Array.from(el.childNodes).forEach((child) => walk(child, el));
      } else {
        const clone = el.cloneNode(true) as HTMLElement;
        if (wrapper) {
          const shell = wrapper.cloneNode(false) as HTMLElement;
          shell.appendChild(clone);
          content().appendChild(shell);
        } else {
          content().appendChild(clone);
        }
      }
    }
  };

  Array.from(code.childNodes).forEach((child) => walk(child, null));
  rows.push(row);

  // 末尾空行（原文以 \n 结尾时）丢弃，与未包裹时的视觉一致
  if (rows.length > 1) {
    const last = rows[rows.length - 1].lastElementChild;
    if (!last || !last.textContent) rows.pop();
  }

  code.textContent = "";
  rows.forEach((r) => code.appendChild(r));
}

// ─── 图片路径与消毒 ─────────────────────────────────────

/**
 * 正在渲染的文档目录。marked 的 renderer 是全局一次性注册的，拿不到 props，
 * 而判定能不能解相对路径必须用 baseDir，所以用模块变量中转。
 * 安全前提：marked.parse 在本项目是**同步**的（没开 async），
 * 赋值到解析结束中间不会插入另一次渲染。
 */
let activeBaseDir: string | null = null;

marked.use({
  renderer: {
    /**
     * 只接一种情形：指向本地文件但解不出来的图，换成看得见的占位。
     * 其余一律 `return false`——marked 的 use() 在 renderer 返回 false 时
     * 回落到默认渲染器（已核对 marked 18 源码），
     * 也就是能正常显示的图输出一个字节都不变。
     */
    image({ href, text }: Tokens.Image): string | false {
      if (classifyImageSrc(href, activeBaseDir).kind !== "unresolvable") return false;
      return imageMissingHtml(href, text);
    },
  },
});

// ─── 任务列表勾选：给每个 checkbox 编上源码侧序号 ─────────
// 预览态勾选要写回源码，就必须知道「第几个勾选框对应源码第几个任务项」。
// 序号由 lexer 顺序决定（代码块里的 `- [ ]` 不会产生 checkbox token），
// 与 `scanTaskItemsFromTokens` 同源 ⇒ 写回侧按下标取位置不会错位。
// 定位不可信时整批写 `-1`：渲染成只读，绝不猜一行去改。
let activeTasks: ReturnType<typeof scanTaskItemsFromTokens>["items"] | null = null;
let taskSeq = 0;

marked.use({
  renderer: {
    checkbox({ checked }: Tokens.Checkbox): string {
      const seq = taskSeq++;
      const idx = activeTasks && activeTasks[seq] ? seq : -1;
      return `<input ${checked ? 'checked="" ' : ""}disabled="" type="checkbox" data-task-i="${idx}"> `;
    },
  },
});

// `{{字段}}` 表单语法糖。挂在 inline 层，代码块与行内代码里的同名文本天然不受影响。
// 预览与导出共用这一份（导出侧在 exportRender 里另行注册到独立实例）。
marked.use(FORM_SUGAR_EXT);

/**
 * 解析前把 Markdown 中的本地图片路径改写为 asset 协议地址。
 * 必须在 DOMPurify 之前完成——否则 "C:/..." 这类驱动路径会被当作不安全协议剥掉 src。
 * 兼容 ![alt](src)、![alt](src "title")、![alt](<src with spaces>)。
 */
function rewriteLocalImagePaths(md: string, baseDir?: string | null): string {
  return md.replace(
    /(!\[[^\]]*\]\(\s*)(<[^>]*>|[^)\s]+)((?:\s+"[^"]*")?\s*\))/g,
    (match, prefix: string, src: string, suffix: string) => {
      const wrapped = src.startsWith("<") && src.endsWith(">");
      const inner = wrapped ? src.slice(1, -1) : src;
      const assetUrl = toAssetUrl(inner, baseDir);
      return assetUrl ? `${prefix}${assetUrl}${suffix}` : match;
    }
  );
}

/** 将 Markdown 文本渲染为安全的 HTML 字符串 */
export function renderMarkdownHtml(text: string, baseDir?: string | null): string {
  // image 渲染器靠这个模块变量拿 baseDir（见 activeBaseDir 注释），
  // finally 里必须清掉：不清的话下一个不传 baseDir 的调用方会接手上一次的目录
  activeBaseDir = baseDir ?? null;
  // 标题 slug 计数必须每次解析归零，否则同一文档重渲染会得到安装步骤-1
  resetHeadingSlugState();
  // checkbox 序号同理：每次解析从 0 开始，才能和 scanTaskItemsFromTokens 的下标对齐
  taskSeq = 0;
  activeTasks = null;
  try {
    // 任务项位置必须相对**原始文本**计算——写回是打在原文上的，而
    // rewriteLocalImagePaths 会改变字节长度（只影响解析）。故扫描用 text。
    // 无 `[ ]` 痕迹时跳过这次 lex，普通文档零额外开销。
    if (/\[[ xX]\]/.test(text)) {
      const scan = scanTaskItemsFromTokens(marked.lexer(text), text);
      activeTasks = scan.complete ? scan.items : null;
    }
    const raw = transformAlerts(marked.parse(rewriteLocalImagePaths(text, baseDir)) as string);
    return DOMPurify.sanitize(raw, {
      ADD_TAGS: ["input"],
      ADD_ATTR: ["type", "checked", "disabled"],
    });
  } catch {
    return "";
  } finally {
    activeBaseDir = null;
    activeTasks = null;
  }
}
