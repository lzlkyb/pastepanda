import { memo, useMemo, useRef, useEffect, useState } from "react";
import { marked, type Tokens } from "marked";
import DOMPurify from "dompurify";
import { convertFileSrc } from "@tauri-apps/api/core";
import styles from "./MarkdownRenderer.module.css";

// marked 全局配置（只执行一次）
marked.setOptions({
  gfm: true,
  breaks: true,
});

// ─── 代码块渲染器：窗口彩点 + 语言页签 + 复制按钮 ─────────
// marked 输出的是原始 HTML 字符串，无法引用 CSS Modules 哈希类名，
// 故代码块外壳使用全局类名 md-code*（样式见 module.css 的 :global 段）。

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const COPY_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>';

marked.use({
  renderer: {
    code({ text, lang }: Tokens.Code): string {
      const language = (lang || "").trim().split(/\s+/)[0].toLowerCase();
      const langLabel = language ? escapeHtml(language) : "text";
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
  },
});

// ─── GFM 提示块（> [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION]）───
// marked 原生不解析，零依赖方案：在解析产物上把带标记的 blockquote 改写为 alert 卡片。

type AlertKind = "NOTE" | "TIP" | "IMPORTANT" | "WARNING" | "CAUTION";

const ALERT_META: Record<AlertKind, { label: string; icon: string }> = {
  NOTE: {
    label: "注意",
    icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm-1 3h2v2H7zm0 3h2v5H7z"/></svg>',
  },
  TIP: {
    label: "提示",
    icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1a5 5 0 0 0-3 9c.6.5 1 1.2 1 2h4c0-.8.4-1.5 1-2a5 5 0 0 0-3-9zM6 13h4v1a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-1z"/></svg>',
  },
  IMPORTANT: {
    label: "重要",
    icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1l1.8 5.2L15 8l-5.2 1.8L8 15l-1.8-5.2L1 8l5.2-1.8L8 1z"/></svg>',
  },
  WARNING: {
    label: "警告",
    icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1 1 14h14L8 1zm-1 5h2v4H7zm0 5h2v2H7z"/></svg>',
  },
  CAUTION: {
    label: "小心",
    icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5 1h6l4 4v6l-4 4H5l-4-4V5l4-4zm2 3v5h2V4H7zm0 6v2h2v-2H7z"/></svg>',
  },
};

const ALERT_OPEN_RE = /^\s*<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(?:<br\s*\/?>)?\s*(<\/p>)?/;

function transformAlerts(html: string): string {
  return html.replace(/<blockquote>([\s\S]*?)<\/blockquote>/g, (match, inner: string) => {
    const m = inner.match(ALERT_OPEN_RE);
    if (!m) return match;
    const kind = m[1] as AlertKind;
    const meta = ALERT_META[kind];
    const standalone = !!m[2]; // 标记独占一段（[!NOTE]</p>）vs 与正文同段（[!NOTE]<br>正文）
    const rest = inner.slice(m[0].length);
    const body = standalone ? rest : `<p>${rest}`;
    return (
      `<div class="md-alert md-alert-${kind.toLowerCase()}">` +
      `<span class="md-alert-ic">${meta.icon}</span>` +
      `<div class="md-alert-bd"><p class="md-alert-t">${meta.label}</p>${body}</div>` +
      `</div>`
    );
  });
}

// ─── 行号模式：代码块按行包裹 / 解包（全局类 md-cl / md-cln / md-clc）───
// hljs 高亮完成后把 <code> 内容按 \n 拆成行结构以显示行号；
// 重新高亮前必须先解包——否则行号文本会混入 textContent 污染源码。

/** 将已包裹的行结构还原为纯文本（textContent 与包裹前逐字一致，保证重高亮幂等） */
function unwrapCodeLines(code: HTMLElement): void {
  const rows = code.querySelectorAll(":scope > .md-cl");
  if (rows.length === 0) return;
  const lines = Array.from(rows).map((r) => r.querySelector(".md-clc")?.textContent ?? "");
  code.textContent = lines.join("\n");
}

/** 把高亮后的 <code> 内容按行拆为 md-cl 行（行号 md-cln + 内容 md-clc） */
function wrapCodeLines(code: HTMLElement): void {
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

/** 将本地图片路径转为 asset 协议地址；已是网络 / 内联资源或非绝对路径时返回 null */
function toAssetUrl(src: string): string | null {
  if (!src) return null;
  if (/^(https?:|data:|blob:|asset:)/i.test(src)) return null;
  if (src.includes("asset.localhost")) return null;
  // 仅处理绝对路径（Windows 盘符 / UNC / Unix 根），相对路径保持原样
  if (!/^([a-zA-Z]:[/\\]|\\\\|\/)/.test(src)) return null;
  return convertFileSrc(src);
}

/**
 * 解析前把 Markdown 中的本地图片路径改写为 asset 协议地址。
 * 必须在 DOMPurify 之前完成——否则 "C:/..." 这类驱动路径会被当作不安全协议剥掉 src。
 * 兼容 ![alt](src)、![alt](src "title")、![alt](<src with spaces>)。
 */
function rewriteLocalImagePaths(md: string): string {
  return md.replace(
    /(!\[[^\]]*\]\(\s*)(<[^>]*>|[^)\s]+)((?:\s+"[^"]*")?\s*\))/g,
    (match, prefix: string, src: string, suffix: string) => {
      const wrapped = src.startsWith("<") && src.endsWith(">");
      const inner = wrapped ? src.slice(1, -1) : src;
      const assetUrl = toAssetUrl(inner);
      return assetUrl ? `${prefix}${assetUrl}${suffix}` : match;
    }
  );
}

/** 将 Markdown 文本渲染为安全的 HTML 字符串 */
function renderMarkdownHtml(text: string): string {
  try {
    const raw = transformAlerts(marked.parse(rewriteLocalImagePaths(text)) as string);
    return DOMPurify.sanitize(raw, {
      ADD_TAGS: ["input"],
      ADD_ATTR: ["type", "checked", "disabled"],
    });
  } catch {
    return "";
  }
}

/**
 * Markdown 渲染组件
 * - 使用 marked 解析 + DOMPurify 防 XSS
 * - 代码块带窗口彩点 / 语言页签 / 复制按钮（事件委托）
 * - GFM 提示块（> [!NOTE] 等）渲染为图标 callout 卡片
 * - highlight.js 对代码块做语法高亮（异步加载后生效）
 * - compact 模式用于 hover 弹窗（限高、小字号、隐藏代码块头部）
 * - lineNumbers 行号模式（全屏编辑器预览）：顶层块注入可点击块编号
 *   （md-blknum，点击闪烁高亮整块）+ 代码块按行包裹行号（md-cl）
 */
export const MarkdownRenderer = memo(function MarkdownRenderer({
  text,
  compact = false,
  className,
  debounceMs = 0,
  lineNumbers = false,
}: {
  text: string;
  compact?: boolean;
  className?: string;
  /** 防抖毫秒数：>0 时延迟渲染，避免大文档每次击键都重解析（默认 0 立即渲染） */
  debounceMs?: number;
  /** 行号模式：块级行号 + 代码块行号（compact 下强制关闭） */
  lineNumbers?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  // 防抖：debounceMs>0 时延迟更新待渲染文本，减少高频解析
  const [debouncedText, setDebouncedText] = useState(text);
  useEffect(() => {
    if (debounceMs <= 0) return;
    const t = setTimeout(() => setDebouncedText(text), debounceMs);
    return () => clearTimeout(t);
  }, [text, debounceMs]);

  const source = debounceMs > 0 ? debouncedText : text;
  const html = useMemo(() => renderMarkdownHtml(source), [source]);

  /** 行号模式实际生效值：compact（hover 弹窗）下强制关闭 */
  const showLineNumbers = lineNumbers && !compact;

  // 代码块语法高亮（hljs 异步加载，避免阻塞首屏）
  // 行号模式：高亮前解包旧行结构（行号文本不得混入源码），高亮后按行重新包裹
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const blocks = el.querySelectorAll("pre code");
    if (blocks.length === 0) return;
    blocks.forEach((block) => unwrapCodeLines(block as HTMLElement));
    let cancelled = false;
    import("highlight.js/lib/common").then((hljs) => {
      if (cancelled) return;
      blocks.forEach((block) => {
        hljs.default.highlightElement(block as HTMLElement);
      });
    }).catch(() => { /* hljs 加载失败时保持纯文本 */ })
      .finally(() => {
        if (cancelled || !showLineNumbers) return;
        blocks.forEach((block) => wrapCodeLines(block as HTMLElement));
      });
    return () => { cancelled = true; };
  }, [html, showLineNumbers]);

  // 块级行号注入：每个非 hr 顶层块插入 md-blknum 编号（点击闪烁见委托事件）。
  // dangerouslySetInnerHTML 重渲染会整体替换子树，故 html 变化后需重新注入；
  // 开关关闭时 html 可能未变（子树不替换），须主动清除残留编号
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.querySelectorAll(".md-blknum").forEach((s) => s.remove());
    if (!showLineNumbers) return;
    let n = 0;
    Array.from(el.children).forEach((child) => {
      if (child.tagName === "HR") return;
      n += 1;
      const span = document.createElement("span");
      span.className = "md-blknum";
      span.textContent = String(n);
      child.insertBefore(span, child.firstChild);
    });
  }, [html, showLineNumbers]);

  // 点击事件委托（html 变化无需重绑）：块行号闪烁定位 + 代码块复制
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      // 块级行号：点击闪烁高亮整个内容块，辅助浏览定位
      const blknum = (e.target as HTMLElement).closest(".md-blknum") as HTMLElement | null;
      if (blknum && el.contains(blknum)) {
        const block = blknum.parentElement;
        if (block) {
          block.classList.add("md-flash");
          setTimeout(() => block.classList.remove("md-flash"), 900);
        }
        return;
      }
      const btn = (e.target as HTMLElement).closest(".md-copybtn") as HTMLButtonElement | null;
      if (!btn || !el.contains(btn)) return;
      const pre = btn.closest(".md-codeblock")?.querySelector("pre");
      if (!pre) return;
      // 行号模式下逐行拼接 md-clc（排除行号列），否则沿用 innerText
      const lineEls = pre.querySelectorAll(".md-clc");
      const copyText =
        lineEls.length > 0
          ? Array.from(lineEls).map((l) => l.textContent ?? "").join("\n")
          : pre.innerText;
      navigator.clipboard?.writeText(copyText).then(() => {
        btn.textContent = "✓ 已复制";
        btn.classList.add("md-copied");
        setTimeout(() => {
          btn.innerHTML = `${COPY_ICON} 复制`;
          btn.classList.remove("md-copied");
        }, 1200);
      }).catch(() => { /* 剪贴板不可用时静默 */ });
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, []);

  return (
    <div
      ref={containerRef}
      className={`${styles.md} ${compact ? styles.compact : ""} ${showLineNumbers ? "md-ln" : ""} ${className || ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
