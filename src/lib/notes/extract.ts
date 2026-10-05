/**
 * 卡片 → 笔记初稿的抽取规则（知识库 A 阶段 · 规划 §8.1 3️⃣，设计稿 §7）。
 *
 * 为何单独成文件而不写在弹窗里：这是一堆按类型分支的纯函数，可以直接单测；
 * 而弹窗里写就得渲染一个 CodeMirror 才能验证一条抽取规则。
 *
 * 🔴 红线：纯本地字符串处理，不调 AI、不联网。
 */
import type { HistoryItem } from "@/stores/appStore";
import type { ImageOcrState } from "@/lib/utils";
import { getImageOcrFullText } from "@/lib/utils";
import { parseCsv, csvToMarkdown } from "@/lib/csv";
import { htmlToMarkdown } from "./htmlToMd";

/** 笔记初稿。`null` = 这张卡片不适合转笔记（菜单项应该根本不出现）。 */
export interface NoteDraft {
  title: string;
  content: string;
}

/** 标题取多长。超了截断——标题行就那么宽，长标题只会变成一条省略号。 */
const TITLE_MAX = 60;

/**
 * 从正文抽一个标题：第一行非空内容，去掉 Markdown 标题标记。
 *
 * 不用「前 N 个字」而用第一行：剪贴板内容绝大多数首行就是它自己的题（代码的函数名、
 * 文章的标题、链接本体），而跨行拉只会把下一句的开头拼进标题。
 */
export function titleFromContent(content: string): string {
  const firstLine = content.split("\n").find((l) => l.trim().length > 0) ?? "";
  // 去 ATX 标题的 #、列表的 - / * / 1.、引用的 >，否则标题会带一堆标点
  const cleaned = firstLine
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/^>\s*/, "")
    .trim();
  if (!cleaned) return "无标题笔记";
  return cleaned.length > TITLE_MAX ? cleaned.slice(0, TITLE_MAX) + "…" : cleaned;
}

/**
 * 按卡片类型抽出笔记初稿。返回 `null` = 不支持转笔记。
 *
 * 调用方拿到 `null` 就**不要注入菜单回调**，而不是先显示再弹错（设计稿 §7）。
 */
export function extractNoteDraft(item: HistoryItem, ocrState?: ImageOcrState): NoteDraft | null {
  switch (item.type) {
    case "file":
      // 文件卡片的全部内容就是一串路径。转成笔记既没有正文可写，
      // 也会让知识库充满下次开机就失效的绝对路径。直接不支持。
      return null;

    case "image": {
      const ocr = getImageOcrFullText(item, ocrState);
      if (!ocr) {
        // 没 OCR 文字的图片：转出来是一条空笔记，没意义。
        // （图片本体不嵌进正文：卡片可能被删，嵌路径就是埋一个日后的碎图）
        return null;
      }
      return {
        title: titleFromContent(ocr),
        // 引用原卡片而不是只留文字：OCR 会错、会漏，用户要能回去看原图。
        // 用一句人话而不是链接：卡片 id 对用户没意义，弹窗顶部自带「查看原卡片 ↗」。
        content: `> 来自图片的识别文字（OCR）\n\n${ocr}`,
      };
    }

    case "diagram":
      // diagram 的结构在 content 里存 JSON，**不能**拿它当正文：
      // 一大段 JSON 对笔记没有阅读价值。text 是它的文本形态，取这个。
      return draftFromText(item.text);

    case "rich":
      // 图文混排：content 里是 CF_HTML（含结构），先转 Markdown 保住标题/列表/
      // 加粗/图片——这是「文章 → 知识库」的主路径。转不出内容（无 HTML /
      // 全是隐藏节点）再退纯文本，行为与升级前一致。
      return draftFromHtml(item) ?? draftFromText(item.text);

    case "doc":
      if (item.content_type === "csv") {
        return draftFromText(item.text, item.content_type);
      }
      // doc 的 content 同样是 CF_HTML（doc 门控过了才有），同 rich 走转换器
      return draftFromHtml(item) ?? draftFromText(item.text, item.content_type);

    case "text":
    default:
      return draftFromText(item.text, item.content_type);
  }
}

/**
 * HTML 形态的初稿。`null` = 没有 HTML 或转不出可读内容，调用方回退纯文本。
 *
 * 🔴 rich/doc 卡片转笔记**只有这一个入口**碰 HTML（规则 #11 收口）：
 * 手动「转为笔记」、待沉淀区、星标自动沉淀、链接抓取最终都汇到这里，
 * 谁都不许绕开它自己拿 `item.content` 拼正文。
 *
 * 还有一道**保底回退**：转换结果明显短于纯文本（去空白后不足六成），
 * 说明 HTML 解析丢了内容（源应用的 CF_HTML 只有片段是常见病），
 * 此时纯文本更可信——转笔记宁可要全的散文本，不要残缺的结构。
 */
function draftFromHtml(item: HistoryItem): NoteDraft | null {
  const html = item.content;
  if (!html) return null;
  const md = htmlToMarkdown(html);
  if (!md) return null;
  const clean = (s: string) => s.replace(/\s+/g, "");
  const textClean = clean(item.text ?? "");
  if (textClean && clean(md).length < textClean.length * 0.6) return null;
  return { title: titleFromContent(md), content: md };
}

/**
 * 文本类卡片的初稿。`contentType` 为 `csv` 时转成 Markdown 表格——
 * 笔记是 Markdown 渲染的，原样的逗号分隔文本在预览里会糊成一团。
 *
 * 复用 `lib/csv` 的 parseCsv + csvToMarkdown（规则 #11），CsvEditor 的「复制为 Markdown」
 * 走的就是同一对函数。parseCsv 返回 null（列数不齐 / 不足两行）就原文不动。
 */
function draftFromText(text: string, contentType?: string): NoteDraft | null {
  const raw = text ?? "";
  if (!raw.trim()) return null;

  let content = raw;
  if (contentType === "csv") {
    const parsed = parseCsv(raw);
    if (parsed) content = csvToMarkdown(parsed);
  }
  return { title: titleFromContent(content), content };
}

// ⚠ 原先这里还有一个 `noteToMarkdown`，已在 B1 #5 删除：
// frontmatter 的生成与解析已收口到后端 `data_store/note_md.rs`（规则 #11）。
// 前端走 `noteMarkdown()` 命令，与目录导出是同一个函数体。
// 旧的那个一处转义都没有：标题含 `: `、或标签名含逗号，产出的就是非法 YAML。
