/**
 * 图文混排（rich）内容的存储格式 ⇄ 显示格式互转。
 *
 * 两种格式必须严格区分，否则会出现“编辑保存后粘贴回写失效”这类隐蔽 bug：
 *
 * - 存储格式：`<img src="file:///C:/.../img.png">`
 *   这是采集（clipboard_monitor）、粘贴回写（paste_engine）、删除时图片清理
 *   （data_store）三方共用的契约，不能为了前端显示方便就改。
 * - 显示格式：`<img src="http://asset.localhost/..." data-src="file:///...">`
 *   WebView 出于安全限制不能直接加载 file://，必须走 Tauri 的 asset 协议。
 *
 * 为什么要多存一份 data-src：保存时需要把显示 URL 还原成存储路径。反解
 * asset URL（反推百分号编码、盘符大小写、反斜杠/正斜杠差异）很容易不无损，
 * 而无损与否直接决定了图片能不能被找到。直接把原始路径原样带在 data-src 上，
 * 保存时原样读回，就不存在反解不准的问题。
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import DOMPurify from "dompurify";

/** 允许保留的标签（图文混排场景实际用得到的子集，不开放表格/链接/标题） */
const ALLOWED_TAGS = [
  "p", "br", "div", "span",
  "strong", "b", "em", "i", "s", "strike", "del", "u",
  "ul", "ol", "li",
  "img",
];

const ALLOWED_ATTR = ["src", "alt", "data-src", "width", "height"];

/**
 * 允许的 URI 协议。必须显式放开 file: 与 asset:：
 * DOMPurify 默认的 ALLOWED_URI_REGEXP 只含 (f|ht)tps?/mailto/tel/... 不含 file:，
 * 沿用默认值会把所有 <img src="file:///..."> 的 src 整个剥掉（只剩一个空 <img>）。
 * 后果不只是图片不显示：保存时 toStoredHtml 也走同一道消毒，图片引用会被静默
 * 抹掉，而 update_history_rich 会把“旧有新无”的图片当成用户删除去清理磁盘文件——
 * 等于编辑一次就把图全弄丢了。（MarkdownRenderer 里踩过同一个坑，见那边注释）
 * 注意没有放开 data:：本流程里图片一律已由后端落盘成文件路径，用不到 data URI。
 */
const ALLOWED_URI_REGEXP =
  /^(?:(?:https?|file|asset):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

/**
 * 消毒：内容来自外部应用的剪贴板（Word / 浏览器 / 任意第三方程序），
 * 必须当作不可信输入处理（可能带 <script>、onerror= 这类东西）。
 * 无论读（展示）还是写（保存）都过一道，不依赖单侧把关。
 */
function sanitize(html: string): string {
  return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOWED_URI_REGEXP });
}

/** file:// URL → 本地文件系统路径（解百分号编码，去掉 Windows 盘符前的多余斜杠） */
function fileUrlToPath(url: string): string | null {
  if (!/^file:/i.test(url)) return null;
  try {
    let p = decodeURIComponent(url.replace(/^file:\/*/i, ""));
    // Windows 盘符路径（C:/...）直接用；UNC 与 Unix 绝对路径补回前导斜杠
    if (!/^[a-zA-Z]:/.test(p)) p = "/" + p;
    return p;
  } catch {
    return null;
  }
}

/** 本地文件系统路径 → file:/// URL（统一正斜杠，与采集侧写入格式一致） */
export function pathToFileUrl(path: string): string {
  return `file:///${path.replace(/\\/g, "/")}`;
}

/**
 * 存储格式 → 显示格式：把 file:// 图片引用换成 asset 协议地址，
 * 原始路径存到 data-src。远程 http(s) 引用不动。
 */
export function toDisplayHtml(storedHtml: string): string {
  if (!storedHtml) return "";
  const doc = new DOMParser().parseFromString(sanitize(storedHtml), "text/html");
  doc.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") || "";
    const localPath = fileUrlToPath(src);
    if (!localPath) return; // 远程引用 / 已是显示地址，原样保留
    img.setAttribute("data-src", src);
    try {
      img.setAttribute("src", convertFileSrc(localPath));
    } catch {
      // convertFileSrc 失败（非 Tauri 环境/测试）：保留原值，图加载不出来但不影响文字
    }
  });
  return doc.body.innerHTML;
}

/**
 * 显示格式 → 存储格式：优先用 data-src 还原原始 file:// 路径，并移除 data-src。
 * 新插入的图片（已经由 saveRichImage 落盘并写好 data-src）也走同一条路径。
 */
export function toStoredHtml(displayHtml: string): string {
  if (!displayHtml) return "";
  const doc = new DOMParser().parseFromString(displayHtml, "text/html");
  doc.querySelectorAll("img").forEach((img) => {
    const dataSrc = img.getAttribute("data-src");
    if (dataSrc) {
      img.setAttribute("src", dataSrc);
      img.removeAttribute("data-src");
    }
  });
  // 消毒放在最后：写入数据库的内容也不应该带危险标签
  return sanitize(doc.body.innerHTML);
}

/**
 * 从存储格式里取第一张本地图片的文件系统路径（列表卡片缩略图用）。
 * 没有本地图片（纯文字或只有远程图）时返回 null，调用方应回退到图文图标。
 */
export function firstLocalImagePath(storedHtml: string): string | null {
  if (!storedHtml) return null;
  const doc = new DOMParser().parseFromString(sanitize(storedHtml), "text/html");
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    const p = fileUrlToPath(img.getAttribute("src") || "");
    if (p) return p;
  }
  return null;
}

/**
 * firstLocalImagePath 的结果缓存。
 * 列表渲染与预加载过滤会对同一批内容反复调用，而过滤是遍历全部历史（可能 200+ 条），
 * 每次都 DOMParser 解析一整段 HTML 会明显拖慢列表。按内容字符串做键，
 * 超出上限直接清空（内容变了键自然不同，不存在读到陈旧值的问题）。
 */
const firstImgCache = new Map<string, string | null>();
const FIRST_IMG_CACHE_MAX = 400;

function firstLocalImagePathCached(storedHtml: string): string | null {
  if (!storedHtml) return null;
  const hit = firstImgCache.get(storedHtml);
  if (hit !== undefined) return hit;
  const val = firstLocalImagePath(storedHtml);
  if (firstImgCache.size >= FIRST_IMG_CACHE_MAX) firstImgCache.clear();
  firstImgCache.set(storedHtml, val);
  return val;
}

/**
 * 取条目用于列表缩略图的本地图片路径：
 * image 类型 content 本身就是图片路径；rich 类型取片段里第一张图。
 * 其他类型（文本/文件）返回 null，调用方渲染图标而不是缩略图。
 */
export function thumbnailSourcePath(item: { type: string; content?: string }): string | null {
  if (item.type === "image") return item.content || null;
  if (item.type === "rich") return firstLocalImagePathCached(item.content || "");
  return null;
}

/** 统计存储格式里的图片张数（详情头部“共 N 张图”提示用） */
export function countImages(storedHtml: string): number {
  if (!storedHtml) return 0;
  const doc = new DOMParser().parseFromString(sanitize(storedHtml), "text/html");
  return doc.querySelectorAll("img").length;
}

/**
 * HTML → 纯文本（保存时同步写回 text 列，供搜索与卡片标题用）。
 * 块级标签转换行，图片不作为文字输出（否则卡片标题会被占位符刷满）。
 */
export function richToPlainText(html: string): string {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(sanitize(html), "text/html");
  doc.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  doc.querySelectorAll("p, div, li").forEach((el) => el.append("\n"));
  return (doc.body.textContent || "")
    // &nbsp; 解成的是 U+00A0 不断行空格，它不算常规空白：trim() 去不掉、
    // 搜索时用户敲的也是普通空格，不归一会导致搜不到（Word 复制的内容大量带它）
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}
