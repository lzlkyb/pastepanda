import { useEffect, useMemo, useRef } from "react";
import { Marked, type Tokens } from "marked";
import DOMPurify from "dompurify";
import { escapeHtml } from "@/lib/markdown/html";
import { copyToClipboard } from "@/lib/utils";
import { useKnowledgeImages } from "./useKnowledgeImages";
import styles from "./KnowledgeReader.module.css";

export type KnowledgeHeading = { id: string; text: string; depth: number };
export function KnowledgeMarkdown({ content, onLink, onHeadings, active = true, onMissingImage, onImage }: {
  content: string; active?: boolean;
  onLink: (url: string, internal: boolean) => void;
  onHeadings?: (headings: KnowledgeHeading[]) => void;
  onMissingImage?: (src: string, reload: () => void) => void;
  onImage?: (src: string, alt: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const rendered = useMemo(() => {
    const headings: KnowledgeHeading[] = [];
    const parser = new Marked({ gfm: true, breaks: true });
    parser.use({ extensions: [{ name: "wiki", level: "inline", start: source => source.indexOf("[["),
      tokenizer(source) {
        const match = /^\[\[([^\]\n]+)\]\]/.exec(source);
        if (match) return { type: "wiki", raw: match[0], text: match[1] };
      }, renderer(token) { return `<a href="#" data-wiki="${escapeHtml(String(token.text))}">${escapeHtml(String(token.text))}</a>`; },
    }], renderer: {
      // Raw imported HTML is shown as text; it cannot create buttons, requests or embedded frames.
      html({ text }: Tokens.HTML | Tokens.Tag) { return escapeHtml(text); },
      heading(token) {
        const id = `kb-heading-${headings.length}`;
        headings.push({ id, text: token.text.replace(/[*_`~]/g, ""), depth: token.depth });
        return `<h${token.depth} id="${id}">${this.parser.parseInline(token.tokens)}</h${token.depth}>`;
      },
      code({ text, lang }) { return `<section class="kb-code"><header><span>${escapeHtml(lang || "代码")}</span><button type="button" data-copy-code>复制代码</button></header><pre><code>${escapeHtml(text)}</code></pre><span class="kb-code-result" role="status"></span></section>`; },
      table(token) { return `<div class="kb-table" tabindex="0" role="region" aria-label="表格，可左右滚动"><table><thead><tr>${token.header.map(cell => `<th>${this.parser.parseInline(cell.tokens)}</th>`).join("")}</tr></thead><tbody>${token.rows.map(row => `<tr>${row.map(cell => `<td>${this.parser.parseInline(cell.tokens)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`; },
      link({ href, tokens }) { return `<a href="${escapeHtml(href)}">${this.parser.parseInline(tokens)}</a>`; },
      image({ href, text }) {
        const online = /^https?:\/\//i.test(href);
        return `<span class="kb-image"><strong>${escapeHtml(text || "图片")}</strong><span>${online ? "外部图片，需要联网查看" : "本机图片"}</span><button type="button" ${online ? "data-external-image" : "data-local-image"}="${escapeHtml(href)}">${online ? "打开外部图片" : "加载本机图片"}</button>${!online && onMissingImage ? `<button type="button" hidden data-fetch-image="${escapeHtml(href)}">取得缺少的图片</button>` : ""}${!online && onImage ? `<button type="button" hidden data-view-image>查看图片</button>` : ""}<span class="kb-image-result" role="status"></span></span>`;
      },
    } });
    return { html: DOMPurify.sanitize(parser.parse(content, { async: false }) as string, {
      ALLOWED_TAGS: ["p", "br", "strong", "em", "del", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "a", "pre", "code", "hr", "table", "thead", "tbody", "tr", "th", "td", "div", "section", "header", "span", "button"],
      ALLOWED_ATTR: ["href", "id", "class", "type", "role", "tabindex", "hidden", "aria-label", "data-wiki", "data-copy-code", "data-external-image", "data-local-image", "data-fetch-image", "data-view-image"],
    }), headings };
  }, [content, !!onMissingImage, !!onImage]);
  const markup = useMemo(() => ({ __html: rendered.html }), [rendered]);
  // Callback is consumed by the parent after mounting the rendered article.
  useEffect(() => onHeadings?.(rendered.headings), [rendered, onHeadings]);
  const loadImage = useKnowledgeImages(root, content, active);

  return <div ref={root} className={styles.markdown} dangerouslySetInnerHTML={markup} onClick={async event => {
    const target = event.target as HTMLElement;
    const image = target.closest<HTMLImageElement>("img");
    if (image && onImage) { onImage(image.src, image.alt); return; }
    const view = target.closest<HTMLButtonElement>("[data-view-image]");
    if (view && onImage) { const shown = view.closest(".kb-image")?.querySelector("img"); if (shown) onImage(shown.src, shown.alt); return; }
    const fetch = target.closest<HTMLButtonElement>("[data-fetch-image]");
    if (fetch && onMissingImage) {
      const load = fetch.closest(".kb-image")?.querySelector<HTMLButtonElement>("[data-local-image]");
      onMissingImage(fetch.dataset.fetchImage || "", () => { if (load && root.current?.contains(load)) loadImage(load); }); return;
    }
    const link = target.closest<HTMLAnchorElement>("a");
    if (link) { event.preventDefault(); onLink(link.dataset.wiki || link.getAttribute("href") || "", !!link.dataset.wiki); return; }
    const copy = target.closest<HTMLButtonElement>("[data-copy-code]");
    if (copy) {
      const block = copy.closest(".kb-code")!;
      copy.disabled = true; copy.textContent = "正在复制…";
      const ok = await copyToClipboard(block.querySelector("code")?.textContent || "");
      copy.disabled = false; copy.textContent = "复制代码";
      block.querySelector(".kb-code-result")!.textContent = ok ? "已复制代码" : "未能复制，请重试或长按选择文字";
      return;
    }
    const external = target.closest<HTMLButtonElement>("[data-external-image]");
    if (external) { onLink(external.dataset.externalImage || "", false); return; }
    const load = target.closest<HTMLButtonElement>("[data-local-image]");
    if (load) await loadImage(load);
  }} />;
}
