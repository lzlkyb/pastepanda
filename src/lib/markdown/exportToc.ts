/**
 * 导出文件的目录（大纲）—— 纯字符串，不碰 DOM。
 *
 * 为什么是 `<details>` + 锚点、不嵌 JS：导出文件的既有约束是「纯阅读的产物零脚本」
 * （见 exportDoc.ts 的设计约束 ④）。大纲是导航，不是交互数据，用原生折叠元素 + `#id`
 * 跳转就够了；一旦为它嵌脚本，纯阅读导出也跟着长出攻击面，代价不值。
 *
 * 素材来源是 `headingHtml`（headingAnchor.ts）产出的标题：它已经带了 `id` 与
 * `data-md-heading`，同一个 allocator 保证 id 在文档内唯一。这里只做「读出来 + 排成列表」，
 * 不重新生成 slug——重新生成就会和正文对不上，点目录跳不动。
 */
import { escapeHtml } from "./html";

export interface TocItem {
  /** 1..6，与 h1..h6 对应 */
  depth: number;
  /** 正文标题的 id（已按属性上下文转义，可直接塞进 href 与 class 之外的任何属性位） */
  id: string;
  /** 纯文本，已剥掉预览用的 `#` 锚点与行内标签 */
  text: string;
}

/** 抓 heading 标签。用反向引用保证开闭标签同深度，`<h2>…</h3>` 不会被误配 */
const HEADING_RE = /<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi;
/** 预览侧的「复制此标题链接」锚点，不属于标题文字 */
const HANCHOR_RE = /<a\b[^>]*md-hanchor[^>]*>[\s\S]*?<\/a>/gi;
const TAG_RE = /<[^>]*>/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function attrOf(attrs: string, key: string): string | null {
  const m = new RegExp(`(?:^|\\s)${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attrs);
  if (!m) return null;
  return m[1] ?? m[2] ?? null;
}

/** 标题纯文本：剥掉锚点 → 剥掉所有标签 → 解实体 → 折空白。
 *
 * 为什么必须解实体：正文里 `&amp;` 已经是**转义后**的文本，直接塞进目录再转义一次
 * 就变成 `&amp;amp;`，屏幕上显示成 `&amp;`。解一次再转义，才是「所见即所示」。 */
function plainOf(inner: string): string {
  return decodeEntities(
    inner.replace(HANCHOR_RE, "").replace(TAG_RE, ""),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 从正文 HTML 抽出标题清单（保持文档顺序）。
 *
 * 没有 `id` 的标题直接跳过：它在正文里点不动、目录里也就没有可跳的目标，
 * 列出来只会得到一个 `href="#"` 的死链。
 */
export function collectHeadings(bodyHtml: string): TocItem[] {
  const items: TocItem[] = [];
  HEADING_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HEADING_RE.exec(bodyHtml))) {
    const id = attrOf(m[2], "id");
    if (!id) continue;
    const text = plainOf(m[3]);
    items.push({ depth: Number(m[1]), id, text: text || id });
  }
  return items;
}

/**
 * 目录 HTML。少于 2 条标题返回空串——只有一个标题的文档，「目录」比正文还长，
 * 纯属噪声；而 1 条时用户滚一下就到了，不需要导航。
 */
export function buildTocHtml(items: TocItem[]): string {
  if (items.length < 2) return "";
  // 以最小深度为 1 级：文档从 h2 起写（很常见）时不会整体右移一大截
  const min = Math.min(...items.map((i) => i.depth));
  const rows = items.map((item) => {
    const level = Math.min(6, Math.max(1, item.depth - min + 1));
    return (
      `<li class="pp-toc-i pp-toc-l${level}">` +
      `<a href="#${item.id}" title="${escapeHtml(item.text)}">${escapeHtml(item.text)}</a>` +
      `</li>`
    );
  });
  return (
    `<nav class="pp-toc" aria-label="目录">` +
    `<details open>` +
    `<summary>目录 · ${items.length} 节</summary>` +
    `<ol class="pp-toc-list">${rows.join("")}</ol>` +
    `</details>` +
    `</nav>`
  );
}
