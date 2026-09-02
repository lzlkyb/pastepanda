/**
 * Markdown 里图片地址的归类与「图没跟过来」占位。
 *
 * 从 `components/MarkdownRenderer.tsx` 抽出来的两个理由：
 * ① 那个文件已经 561 行，远超规则 #7 的 300 行（它在本次改动**之前**就已经 470 行）；
 * ② 这里面全是**纯函数**，单测不需要 jsdom。
 *
 * 🔴 红线：无 AI。纯字符串与路径计算。
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import { escapeHtml } from "./html";

/**
 * 把相对路径拼到文档目录上（自己算而不用 path.join：浏览器侧没有，
 * 而 @tauri-apps/api/path 的 join 是 async，而这里在同步的字符串改写里）。
 * 处理 `./` 与 `../`；分隔符跟着 baseDir 走。
 */
function resolveAgainst(baseDir: string, rel: string): string {
  const sep = baseDir.includes("\\") ? "\\" : "/";
  const parts = baseDir.split(/[/\\]/);
  for (const seg of rel.split(/[/\\]/)) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 1) parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join(sep);
}

/**
 * 图片地址的三种归属：
 * - `skip`：网络 / 内联资源（http、data、blob、asset…），本来就不该动它
 * - `resolved`：指向本地文件且能算出 asset 协议地址
 * - `unresolvable`：指向本地文件，但没有文档目录，相对路径算不出来
 */
export type ImageSrcKind = "skip" | "resolved" | "unresolvable";

/**
 * 判定一个图片地址属于哪一类，能解时顺带给出 asset 协议地址。
 *
 * 这里是「这张图能不能显示」的唯一判定处（规则 #11.1 收口）：
 * 改写 Markdown 的 rewriteLocalImagePaths 与渲染占位的 image 渲染器都调它。
 * 两边各写一套 if 迟早对不上——一边已经改写成 asset 地址、另一边还当它解不了，
 * 就会给能正常显示的图也挂上占位。
 *
 * @param baseDir 文档所在目录。有它才能解相对路径。
 *   剪贴板内容模式没有文档目录，那时相对路径确实无法解，判为 unresolvable。
 */
export function classifyImageSrc(
  src: string,
  baseDir?: string | null,
): { kind: ImageSrcKind; url?: string } {
  if (!src) return { kind: "skip" };
  if (/^(https?:|data:|blob:|asset:)/i.test(src)) return { kind: "skip" };
  if (src.includes("asset.localhost")) return { kind: "skip" };
  const isAbs = /^([a-zA-Z]:[/\\]|\\\\|\/)/.test(src);
  if (!isAbs) {
    if (!baseDir) {
      // 没有文档目录，相对路径解不出来。但先排掉带协议头的地址
      // （mailto:、以及各种自定义协议）：那不是本地文件，挂占位属于误伤。
      // 单字母加冒号是 Windows 盘符，已被上面的 isAbs 接走，不会走到这里。
      if (/^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(src)) return { kind: "skip" };
      return { kind: "unresolvable" };
    }
    // Markdown 里空格常写成 %20，拼路径前得先还原成真实文件名
    let rel = src;
    try {
      rel = decodeURIComponent(src);
    } catch {
      /* 不是合法百分号转义（如文件名里就带 %），按原样拼 */
    }
    return { kind: "resolved", url: convertFileSrc(resolveAgainst(baseDir, rel)) };
  }
  return { kind: "resolved", url: convertFileSrc(src) };
}

/** 将本地图片路径转为 asset 协议地址；不属于「能解的本地文件」时返回 null */
export function toAssetUrl(src: string, baseDir?: string | null): string | null {
  const r = classifyImageSrc(src, baseDir);
  return r.kind === "resolved" ? r.url ?? null : null;
}

const IMG_MISS_ICON =
  '<svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' +
  '<path d="M1 3h14v10H1V3zm1.4 1.4v7.2h11.2V4.4H2.4z"/>' +
  '<path d="M4.4 5.6a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2z"/>' +
  '<path d="M3.2 11.2 6 7.9l1.9 2.2 2.1-2.6 2.8 3.7z"/></svg>';

/**
 * 「本地图片解不出来」的占位（全局类 `md-imgmiss*`）。
 *
 * 为何不当错误报：典型场景是从 Obsidian 之类的库导入笔记，正文里带着
 * `![](attachments/x.png)` 而附件文件并没搬过来。文本本身是好的，
 * 用户需要知道的是「这里原本有张图、原路径是什么」，好自己去找回来。
 * 之前这里是一个加不出来的 `<img>`（alt 常为空），渲染出来完全不可见，
 * 用户连「原文里有图」都不知道。
 *
 * ❗ 只用 `<span>`：占位可能出现在段落中间（`文字 ![](a.png) 文字`），
 *   塞 `<div>` 会被浏览器从 `<p>` 里踢出来，把一段拆成三段。
 *
 * @param alt 原 markdown 的 alt 文本。有它就显示——那往往是唯一能说明
 *   这张图是什么的信息（路径只能说明它存在过）。
 */
export function imageMissingHtml(src: string, alt: string): string {
  const label = alt.trim();
  return (
    `<span class="md-imgmiss" title="${escapeHtml(src)}">` +
    `<span class="md-imgmiss-ic">${IMG_MISS_ICON}</span>` +
    `<span class="md-imgmiss-bd">` +
    `<span class="md-imgmiss-t">图片没跟过来</span>` +
    (label ? `<span class="md-imgmiss-alt">${escapeHtml(label)}</span>` : "") +
    `<span class="md-imgmiss-p">原路径：${escapeHtml(src)}</span>` +
    `</span></span>`
  );
}
