/**
 * HTML → Markdown 转换器（「文章 → 知识库」阶段 1）。
 *
 * 为什么手写白名单而不是引 turndown：剪贴板 CF_HTML 与抓取正文是**可控输入**，
 * 我们只关心文章骨架（标题/段落/列表/加粗/链接/图片/代码/引用/表格），
 * 白名单天然把 mso 样式、span 噪声、导航残片拒之门外；零依赖、行为完全可测。
 *
 * 🔴 红线：纯本地字符串处理，不调 AI、不联网（与 extract.ts 同一口径）。
 *
 * 三个实测沉淀的规则（2026-10-05 微信文章链接验证）：
 * 1. `<a>` 必须转成 `[文本](href)`——微信文章的内链（作者引用旧文）丢了
 *    a 标签后句子读不通；
 * 2. `display:none / visibility:hidden / opacity:0 / font-size:0` 的节点整棵丢弃
 *    ——网页正文里确实混着隐藏杂质；
 * 3. 图片地址取 `data-src` 优先于 `src`——微信等站点全站懒加载，
 *    src 里是占位符，真实地址在 data-src。
 */

/** 超过这个长度的 data: URI 图片不进正文：一段 100KB 的 base64 塞进笔记
 *  既撑爆数据库又没有阅读价值。抓取路径的远程图已由后端落盘成 file://，
 *  正常走不到这里；这条只兜「复制内容里内联巨图」的底。 */
const MAX_DATA_URI_LENGTH = 64 * 1024;

/** 每次转换的 HTML 输入上限（与后端 doc 采集的 200KB 片段门控同数量级）。 */
const MAX_HTML_INPUT_CHARS = 512 * 1024;

interface Block {
  /** 已带块间换行的 Markdown 片段；空串 = 无内容 */
  md: string;
}

const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "details", "dd", "div", "dl",
  "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2",
  "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "li", "main", "nav",
  "ol", "p", "pre", "section", "summary", "table", "tbody", "tfoot", "thead",
  "tr", "td", "th", "ul",
]);

/** 整棵丢掉的标签：脚本/样式/表单控件对笔记只有噪声。 */
const SKIP_TAGS = new Set([
  "script", "style", "noscript", "template", "iframe", "object", "embed",
  "video", "audio", "canvas", "svg", "select", "option", "input", "button",
  "textarea", "form", "head", "link", "meta", "map", "area",
]);

/** 节点是否被内联样式隐藏。剪贴板片段与抓取正文里只有内联样式可查
 *  （没有样式表环境），覆盖四种主流隐藏写法。透明度/字号按数值判断，
 *  字符串前缀匹配会把 `opacity:0.0` 和 `opacity:0.5` 混为一谈。 */
function isHiddenByStyle(el: Element): boolean {
  const style = el.getAttribute("style");
  if (!style) return false;
  const s = style.replace(/\s+/g, "").toLowerCase();
  if (s.includes("display:none") || s.includes("visibility:hidden")) return true;
  const opacity = s.match(/opacity:([0-9.]+)/);
  if (opacity && Number.parseFloat(opacity[1]) < 0.05) return true;
  const fontSize = s.match(/font-size:([0-9.]+)(?:px|rem|em|pt)?/);
  if (fontSize && Number.parseFloat(fontSize[1]) < 1) return true;
  return false;
}

/** 图片真实地址：data-src 优先（懒加载），都没有就放弃。 */
function imgSrc(el: Element): string | null {
  const src =
    el.getAttribute("data-src") ??
    el.getAttribute("data-original") ??
    el.getAttribute("src");
  const t = src?.trim();
  return t ? t : null;
}

/**
 * 笔记语境的图片地址归一：`file:///C:/…` → 裸盘符路径 `C:/…`。
 *
 * 为什么必须剥：采集侧把 CF_HTML 内嵌图片改写成 file:/// 是**粘贴回写**的格式；
 * 而笔记预览的渲染管线（classifyImageSrc → DOMPurify）不认 file: 协议——
 * `file:` 会被当协议地址跳过、随后被 DOMPurify 剥掉 src，预览里就是一个空 img。
 * 裸盘符路径才会走 resolved → convertFileSrc（asset 协议）正常显示。
 * 只有笔记这条路做这个转换（收口在 htmlToMd，规则 #11）：粘贴用的 CF_HTML 不经过这里。
 */
function srcForNote(raw: string): string {
  if (!raw.startsWith("file://")) return raw;
  // file:///C:/x → "/C:/x"；file:///home/x → "/home/x"。先剥 file://，再按
  // 「斜杠后跟盘符」识别 Windows 根，把那道斜杠也去掉。
  let p = raw.slice("file://".length);
  try {
    p = decodeURIComponent(p);
  } catch {
    /* 文件名里本身带 % 时按原样用 */
  }
  if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
  return p;
}

function imgToMd(el: Element): string {
  const src = imgSrc(el);
  if (!src) return "";
  if (src.startsWith("data:") && src.length > MAX_DATA_URI_LENGTH) {
    return el.getAttribute("alt") ?? "";
  }
  const alt = el.getAttribute("alt") ?? "";
  return `![${alt}](${mdUrl(srcForNote(src))})`;
}

/** href/src 进 Markdown 括号体前的收尾：含空格或括号的地址用尖括号包裹
 *  （GFM 合法），否则链接在第一个空格处断掉。 */
function mdUrl(url: string): string {
  const trimmed = url.trim();
  return /[\s()]/.test(trimmed) ? `<${trimmed}>` : trimmed;
}

/** 行内元素 → Markdown 行内文本。返回的字符串**不含**首尾空白。 */
function inlineToMd(el: Element): string {
  switch (el.tagName.toLowerCase()) {
    case "br":
      return "\n";
    case "strong":
    case "b": {
      const inner = childrenInlineToMd(el);
      return inner ? `**${inner}**` : "";
    }
    case "em":
    case "i": {
      const inner = childrenInlineToMd(el);
      return inner ? `*${inner}*` : "";
    }
    case "code": {
      const inner = el.textContent ?? "";
      return inner.trim() ? `\`${inner.trim()}\`` : "";
    }
    case "a": {
      const inner = childrenInlineToMd(el);
      if (!inner) return "";
      const href = el.getAttribute("href")?.trim();
      // 锚点/javascript: 之类不是链接内容，只留文字；微信文章的内链是 http(s)
      if (!href || /^(javascript:|#)/i.test(href)) return inner;
      return `[${inner}](${mdUrl(href)})`;
    }
    case "img":
      return imgToMd(el);
    default:
      // span / u / font / sup / sub / mark 等一律透明穿透
      return childrenInlineToMd(el);
  }
}

/** 混合子节点（文本 + 元素）→ 行内文本。 */
function childrenInlineToMd(el: Element): string {
  let out = "";
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += (node.textContent ?? "").replace(/\s+/g, " ");
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const child = node as Element;
      if (SKIP_TAGS.has(child.tagName.toLowerCase()) || isHiddenByStyle(child)) continue;
      if (BLOCK_TAGS.has(child.tagName.toLowerCase())) {
        // 行内上下文里混进块级元素（浏览器容错常见）：按换行降级，不吞内容
        out += "\n" + convertChildren(child).md;
      } else {
        out += inlineToMd(child);
      }
    }
  }
  return collapseSpaces(out);
}

/** 折叠空白：连续空格/制表符并成一个，去行尾空格。**不碰换行**（换行是结构）。 */
function collapseSpaces(s: string): string {
  return s
    .replace(/[ \t\r]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .trim();
}

/** 块级子节点的统一转换入口（div/section 等容器、p、h*、列表、表格…）。 */
function convertChildren(el: Element): Block {
  const parts: string[] = [];
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      // 块级上下文里的裸文本（容器 div 直接装文字很常见）自成一段
      const t = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      if (t) parts.push(t);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const child = node as Element;
      if (SKIP_TAGS.has(child.tagName.toLowerCase()) || isHiddenByStyle(child)) continue;
      const md = convertBlock(child);
      if (md) parts.push(md);
    }
  }
  return { md: parts.filter(Boolean).join("\n\n") };
}

/** 单个块级元素 → Markdown（带块间空行；空串 = 无内容）。 */
function convertBlock(el: Element): string {
  const tag = el.tagName.toLowerCase();

  if (/^h[1-6]$/.test(tag)) {
    const text = childrenInlineToMd(el).replace(/\n/g, " ");
    return text ? `${"#".repeat(Number(tag[1]))} ${text}` : "";
  }
  if (tag === "p") {
    const text = childrenInlineToMd(el);
    return text || "";
  }
  if (tag === "hr") return "---";
  if (tag === "blockquote") {
    const inner = convertChildren(el).md;
    if (!inner) return "";
    return inner
      .split("\n")
      .map((l) => (l ? `> ${l}` : ">"))
      .join("\n");
  }
  if (tag === "pre") {
    // 语言从 class="language-xxx" / "lang-xxx" 里猜（highlight.js / Prism 惯例）
    const cls = el.getAttribute("class") ?? "";
    const lang = (cls.match(/(?:language|lang)-([\w-]+)/) ?? [])[1] ?? "";
    const code = el.textContent ?? "";
    if (!code.trim()) return "";
    return `\`\`\`${lang}\n${code.replace(/\n$/, "")}\n\`\`\``;
  }
  if (tag === "ul" || tag === "ol") return listToMd(el, tag === "ol", 0);
  if (tag === "table") return tableToMd(el);
  if (tag === "img") {
    const md = imgToMd(el);
    return md || "";
  }
  // 行内元素出现在块级上下文（浏览器容错、或片段直接以 <a>/<strong> 开头）：
  // 走行内转换保住链接/强调语义，不能当容器拆掉——拆了链接就只剩文字
  if (!BLOCK_TAGS.has(tag)) {
    return inlineToMd(el);
  }
  // 容器（div/section/article/p 的父级…）：递归子块
  return convertChildren(el).md;
}

/** 列表（含嵌套）。`depth` 控制缩进，每层两个空格。 */
function listToMd(el: Element, ordered: boolean, depth: number): string {
  const lines: string[] = [];
  let index = 0;
  for (const node of el.childNodes) {
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const child = node as Element;
    const tag = child.tagName.toLowerCase();
    if (tag !== "li") continue;
    if (isHiddenByStyle(child)) continue;
    index += 1;
    // li 内部：先拿「第一个块之前的行内内容」，再拿其余子块
    const { lead, rest } = liContent(child);
    const marker = ordered ? `${index}.` : "-";
    const head = lead ? `${marker} ${lead}` : `${marker}`;
    const restMd = rest.filter(Boolean).join("\n\n");
    const own = restMd
      ? `${head}\n${restMd
          .split("\n")
          .map((l) => (l ? `  ${l}` : ""))
          .join("\n")}`
      : head;
    lines.push(depth > 0 ? own.split("\n").map((l) => `  ${l}`).join("\n") : own);
  }
  return lines.filter(Boolean).join("\n");
}

/** li 内容 = 行内前导 + 子块列表（嵌套 ul/ol 也在这拿）。 */
function liContent(li: Element): { lead: string; rest: string[] } {
  let lead = "";
  const rest: string[] = [];
  for (const node of li.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      lead += (node.textContent ?? "").replace(/\s+/g, " ");
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const child = node as Element;
      const tag = child.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag) || isHiddenByStyle(child)) continue;
      if (tag === "ul" || tag === "ol") {
        rest.push(listToMd(child, tag === "ol", 1));
      } else if (BLOCK_TAGS.has(tag)) {
        const md = convertBlock(child);
        if (md) rest.push(md);
      } else {
        lead += inlineToMd(child);
      }
    }
  }
  return { lead: collapseSpaces(lead), rest };
}

/** GFM 表格。首行含 th 时作表头；否则第一行当表头（GFM 必须有表头行）。 */
function tableToMd(table: Element): string {
  const rows: string[][] = [];
  for (const tr of table.querySelectorAll("tr")) {
    if (tr.closest("tfoot")) continue;
    const cells = Array.from(tr.querySelectorAll("th,td")).map((cell) =>
      childrenInlineToMd(cell).replace(/\n/g, " ").replace(/\|/g, "\\|"),
    );
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => Array.from({ length: width }, (_, i) => r[i] ?? "");
  const body = rows.map(pad);
  const head = body[0];
  const sep = Array.from({ length: width }, () => "---");
  return [head, sep, ...body.slice(1)].map((r) => `| ${r.join(" | ")} |`).join("\n");
}

/**
 * HTML → Markdown。转不出可读内容时返回 `null`，调用方回退纯文本。
 *
 * 输入可以是完整文档也可以是片段（DOMParser 的 text/html 模式两者都兜住，
 * 且文档是惰性的——脚本不会执行）。
 */
export function htmlToMarkdown(html: string): string | null {
  const input = html ?? "";
  if (!input.trim() || input.length > MAX_HTML_INPUT_CHARS) return null;

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(input, "text/html");
  } catch {
    return null;
  }
  const body = doc.body;
  if (!body) return null;

  const { md } = convertChildren(body);
  // 压掉 3 连以上空行；只剩空白 = 没转出东西
  const result = md.replace(/\n{3,}/g, "\n\n").trim();
  return result.length > 0 ? result : null;
}
