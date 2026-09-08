/**
 * 从笔记正文里取第一张本地图片，给列表行的 34px 图标槽当缩略图用
 * （以及后续网格形态的封面）。
 *
 * 为何能纯前端算：列表接口返回的就是 **全文** `content`（现在的摘要
 * 也是前端算的），不需要给 `note_list_view` 加字段。
 *
 * 🔴 红线：无 AI。纯字符串与路径计算。
 */
import { toAssetUrl } from "@/lib/markdown/imageSrc";

/**
 * Markdown 图片语法的两种写法：
 *   `![alt](path "title")`      → 第 2 组（遇空白就停，所以 title 不会被吃进去）
 *   `![alt](<path with space>)` → 第 1 组（尖括号形式才允许路径带空格）
 *
 * ❗ 两个分支各自限长 512：正文里可能嵌着 base64 巨串
 *   （`![](data:image/png;base64,…几百 KB)`）。不限长会把它整串拿出来，
 *   而这个函数每行都要跑一次。
 *
 * 🔴 裸路径分支末尾那个 `` 不是装饰。没它的话，几百 KB 的
 *   base64 会被「截前 512 字符」匹配成功，返回一段既不是路径、
 *   也不是完整 data URI 的垃圾串。加上它之后：要么 512 内碰到 `)` 或空白
 *   （正常路径），要么干脆不匹配。
 *
 * ❗ 不用反向引用匹配尖括号：开头是 `<`、结尾是 `>`，不是同一个字符。
 *   尖括号分支本身就要求 512 内出现 `>`，所以不需要额外的断言。
 */
const COVER_RE = /!\[[^\]]*\]\(\s*(?:<([^>\n]{1,512})>|([^)\s\n]{1,512})(?=[)\s]))/;

/**
 * 取正文第一张图的原始 src（还没转成可显示的 URL）。
 * 拿不到返回 null。
 */
export function coverSrcOf(content: string): string | null {
  if (!content) return null;
  const m = COVER_RE.exec(content);
  if (!m) return null;
  const src = (m[1] ?? m[2] ?? "").trim();
  return src || null;
}

/**
 * 取可直接塞进 `<img src>` 的地址。拿不到返回 null（调用方降级成图标）。
 *
 * 走公共的 [`toAssetUrl`]（规则 #11）而不自己拼 asset 地址：
 * 那里是「这张图能不能显示」的唯一判定处，Markdown 渲染器也走它。
 *
 * ❗ `baseDir` 传 null 是故意的，不是偷懒：笔记在全 app 范围内本来就
 *   没有文档目录（`KbQaTurn.tsx` 渲染笔记正文时也是 `baseDir={null}`），
 *   而笔记里的图由 W1 的附件机制存的是绝对路径。
 *   所以：绝对路径 → 能出缩略图；导入笔记里的相对路径 → 解不出、降级成图标。
 *   这与正文渲染器的行为一致（那边也会摆「图片没跟过来」占位），
 *   不是本次新引入的限制。
 *
 * ❗ `http(s):` / `data:` 会被 `toAssetUrl` 归为 skip → 返回 null。
 *   这是对的：列表一屏几十行，拿远程图当缩略图等于每次滚动都发
 *   一批外网请求（隐私 + 性能都不划算）。
 */
export function coverUrlOf(content: string): string | null {
  const src = coverSrcOf(content);
  return src ? toAssetUrl(src, null) : null;
}

/** 文字封面的深浅档位数。4 档而不是连续取值：
 *  连续取值下相邻两张卡片的差异让人以为那是个有意义的信号（其实不是）。 */
export const COVER_STEPS = 4;

/**
 * 无图笔记的「文字封面」取哪一档深浅。输入 `note.id`，输出 `0 … COVER_STEPS-1`。
 *
 * ❗ 只管**深浅**，不管色相。色相必须跟主题走（CSS 里用 `color-mix`
 *   从 `--accent` 与 `--section-bg` 派生）——自由 HSL 会在 6 个主题里的某个翻车，
 *   而 `theme.css` 里有 28 处带数字的对比度改进标注，绕过它们就是静默回退。
 *
 * ❗ 必须是**稳定**的（同一条笔记每次都一样），所以用 id 而不是列表下标：
 *   用下标的话排序一改、或前面插进一条新笔记，整屏颜色就全变了。
 */
export function coverStepOf(id: string): number {
  // FNV-1a。不用简单累加：uuid 里字符分布集中，累加会让档位扇得很不匀。
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % COVER_STEPS;
}

/**
 * 文字封面上那个大字。拿标题首字，空标题回退成破折号。
 *
 * 🔴 必须 `Array.from(...)[0]` 而不能 `title[0]`：
 *   emoji 与部分生僻字是代理对（两个 UTF-16 码元），
 *   `[0]` 会切出半个码点、渲染成一个方框。
 */
export function coverInitialOf(title: string): string {
  const t = title.trim();
  if (!t) return "—";
  return Array.from(t)[0];
}
