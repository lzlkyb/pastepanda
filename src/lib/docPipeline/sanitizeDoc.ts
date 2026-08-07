/**
 * docPipeline/sanitizeDoc.ts — 文档 HTML 白名单清洗（纯函数，依赖 DOMParser）。
 *
 * 与 richContent.ts 的图文消毒契约隔离：doc 场景需要保留表格/链接/标题，
 * 白名单更宽；不共用 richContent 的 ALLOWED_TAGS，避免互相污染。
 * 不可信输入（Word/浏览器/任意第三方剪贴板）一律先过消毒，删 script/style/mso 噪声。
 */

const ALLOWED_TAGS = new Set([
  "p", "br", "div", "span",
  "strong", "b", "em", "i", "s", "strike", "del", "u",
  "ul", "ol", "li",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th",
  "a", "code", "pre", "blockquote", "hr",
]);

const ALLOWED_ATTR = new Set(["href", "colspan", "rowspan", "alt", "title", "src"]);

/** 整个删掉的标签（含内容，不 unwrap）——脚本/样式/元信息/嵌入对象 */
const REMOVE_ENTIRELY = new Set([
  "script", "style", "meta", "link", "head", "noscript",
  "iframe", "object", "embed", "form", "input", "button", "svg",
]);

/** 危险 URL scheme（href/src 须拒绝） */
const DANGEROUS_SCHEME = /^(?:javascript|vbscript|data):/i;

/** 判断 URL 是否安全（允许 http(s)/mailto/tel/file/相对路径） */
function isSafeUrl(url: string): boolean {
  const trimmed = url.trim().toLowerCase();
  if (!trimmed) return true; // 空值保留（不删属性，可能后续填充）
  // 相对路径 / 锚点 / 非协议开头都安全
  if (/^[a-z]/.test(trimmed) && !trimmed.includes(":")) return true;
  return !DANGEROUS_SCHEME.test(trimmed);
}

/** 清洗一棵子树：先递归子节点，再对当前节点按白名单处理 */
function cleanNode(node: Element): void {
  const children = Array.from(node.children);
  for (const child of children) {
    const tag = child.tagName.toLowerCase();
    // 先递归，确保 unwrap 后的孙子节点也已被清洗
    cleanNode(child);
    if (REMOVE_ENTIRELY.has(tag)) {
      child.remove();
      continue;
    }
    if (!ALLOWED_TAGS.has(tag)) {
      // 不在白名单：unwrap（把子节点提到当前层），保留文本内容
      const parent = child.parentNode;
      if (!parent) continue;
      while (child.firstChild) parent.insertBefore(child.firstChild, child);
      child.remove();
      continue;
    }
    // 删不允许的属性 + 所有 style/class（mso 噪声的主要载体）
    for (const attr of Array.from(child.attributes)) {
      const name = attr.name.toLowerCase();
      if (!ALLOWED_ATTR.has(name)) {
        child.removeAttribute(attr.name);
        continue;
      }
      // href/src 须校验 scheme（防 javascript: 等 XSS）
      if ((name === "href" || name === "src") && !isSafeUrl(attr.value)) {
        child.removeAttribute(attr.name);
      }
    }
  }
}

/** 清洗后的纯文本内容（用于检测空节点） */
function isEmptyAfterClean(node: Element): boolean {
  return !node.textContent?.trim() && node.children.length === 0;
}

/**
 * 文档 HTML 白名单清洗：删 script/style/meta/mso 样式/空节点，
 * 保留表格/链接/标题/列表/代码/引用等结构。
 */
export function sanitizeDocHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  cleanNode(doc.body);
  // 删清洗后变空的叶子节点（重复两轮覆盖嵌套空层）
  // 排除表格元素：空 td/th 被删会导致行列错位（GFM 转换出锯齿列）
  for (let pass = 0; pass < 2; pass++) {
    const empties = Array.from(
      doc.body.querySelectorAll("div,span,p,li,ul,ol,blockquote")
    ).filter((el) => isEmptyAfterClean(el) && !el.querySelector("img,br,hr"));
    empties.forEach((el) => el.remove());
  }
  return doc.body.innerHTML;
}
