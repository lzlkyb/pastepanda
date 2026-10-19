/**
 * Markdown 预览里点击 `<a>` 的归属判定。
 *
 * 为什么必须单独判：在 WebView2 里点一个没拦的 `<a href>` 会**导航当前 webview**，
 * 整个应用被目标页替换掉 —— 没有地址栏、没有后退按钮，用户只能杀掉进程重开。
 * 全屏编辑器里的预览尤其严重（未保存的脏内容还在内存里）。
 *
 * 所以预览里凡是能点的链接，一律先分类：
 * - `anchor`   `#章节` → 容器内滚动（现有 headingAnchor 处理）
 * - `external` http/https/mailto → 交给系统浏览器（后端 open_url 有协议白名单）
 * - `blocked`  其余全部拦下。相对路径（`./other.md`）会被拼成 tauri://localhost/… 后 404，
 *              `file:` / 自定义协议不该从一个文档链接上打开任意本地程序，
 *              `javascript:` 虽已被 DOMPurify 剥掉，这里再兜一层。
 *
 * 🔴 红线：无 AI。纯字符串判定。
 */

export type LinkKind = "anchor" | "external" | "blocked";

/** 与后端 `is_allowed_open_url` 白名单保持一致（http/https/mailto） */
const EXTERNAL_RE = /^(?:https?:\/\/|mailto:)/i;

/** 协议相对地址 `//example.com/a`：浏览器会按当前协议补全，在 tauri:// 下会变成 tauri://example.com */
const PROTOCOL_RELATIVE_RE = /^\/\/[^/]/;

/**
 * 归类一个 href。空值判 blocked（点了什么都不该发生，更不该导航）。
 */
export function classifyLink(href: string | null | undefined): LinkKind {
  const raw = (href ?? "").trim();
  if (!raw) return "blocked";
  if (raw.startsWith("#")) return "anchor";
  if (EXTERNAL_RE.test(raw)) return "external";
  if (PROTOCOL_RELATIVE_RE.test(raw)) return "external";
  return "blocked";
}

/**
 * 取交给系统浏览器的地址：协议相对地址补 https:，其余原样。
 * 返回 null 表示不该外开（调用方应当 preventDefault 后什么都不做）。
 */
export function normalizeExternalUrl(href: string | null | undefined): string | null {
  const raw = (href ?? "").trim();
  if (!raw) return null;
  if (PROTOCOL_RELATIVE_RE.test(raw)) return `https:${raw}`;
  if (EXTERNAL_RE.test(raw)) return raw;
  return null;
}
