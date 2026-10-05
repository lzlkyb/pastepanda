/**
 * 「链接 → 知识库文章」的编排（「文章 → 知识库」阶段 2/4）。
 *
 * 三个消费者：
 * - URL 卡片右键「抓取全文存知识库」（openArticleForCard）
 * - 星标自动沉淀遇到链接卡片（deposit.ts 走 fetchArticleDraft，见阶段 3）
 * - AI 清洗成文（aiComposeArticleForCard，规则 16 门控，阶段 4）
 *
 * 为什么不复用 openNoteForCard：那条路的初稿来自 `extractNoteDraft`
 * （URL 卡片的"正文"只是链接本身）；这里的初稿来自抓取。
 *
 * 🔴 清洗只有一份：抓回来的 HTML 与剪贴板 CF_HTML 走同一个 `htmlToMarkdown`
 * （规则 #11），本模块不做任何自己的 HTML 处理。
 * 🔴 抓取草稿的构造也只有一份（fetchArticleDraft）：手动与自动两条路的
 * 来源行、标题、正文格式必须一致。
 */
import type { HistoryItem } from "@/stores/appStore";
import type { ToastFn } from "@/components/Toast";
import { useDialogStore } from "@/stores/dialogStore";
import { noteByHistory, noteTouch } from "@/lib/api";
import { fetchUrlArticle } from "@/lib/api/url";
import { aiRun } from "@/lib/api/ai";
import { isBareHttpUrl } from "@/lib/url";
import { htmlToMarkdown } from "./htmlToMd";
import { titleFromContent } from "./extract";

/** AI 动作 id（定义在 Rust ai/actions.rs）。 */
const AI_KB_ARTICLE = "ai-kb-article";

/**
 * 抓取 loading toast 的时长。页面抓取上限 12s，多图文章还要串行下载图片；
 * 4s 的默认 info toast 会在抓取中途消失，看起来像"点了没反应"（U1）。
 * 给 15s 盖过绝大多数情形；真超时了错误 toast 会跟上说明。
 */
const FETCH_TOAST_MS = 15_000;

/** AI 清洗的 loading toast 时长。LLM 出稿比抓页更不可预期，给 20s。 */
const AI_TOAST_MS = 20_000;

/**
 * 这张卡片是不是「纯链接卡」。菜单注入以它为准——
 * 返回 false 时菜单项根本不出现，而不是点了再报错（设计稿 §7 口径）。
 */
export function isArticleCard(item: HistoryItem): boolean {
  return item.type === "text" && isBareHttpUrl(item.text ?? "");
}

/**
 * 抓取链接并构造文章草稿（规则 #11 收口：手动抓取与星标自动沉淀共用）。
 *
 * 抛错 = 后端的人话错误（站点反爬/需登录/无正文），调用方负责呈现；
 * 返回 `null` = 抓到了页面但转不出可读正文。
 */
export async function fetchArticleDraft(
  url: string,
): Promise<{ title: string; content: string } | null> {
  const article = await fetchUrlArticle(url);
  const md = htmlToMarkdown(article.html);
  if (!md) return null;
  // 来源行写在最前：文章进了知识库就脱离原页面了，出处必须跟着走
  const sourceLine = article.author
    ? `> 来源：微信公众号「${article.author}」\n> ${article.url}`
    : `> 来源：${article.url}`;
  return {
    title: titleFromContent(article.title || md),
    content: `${sourceLine}\n\n${md}`,
  };
}

/**
 * 抓取这张链接卡片的全文并打开笔记弹窗。
 * 已转过 → 直接打开已有笔记（幂等，不重复抓取、不重复消耗网络）。
 */
export async function openArticleForCard(item: HistoryItem, toast: ToastFn): Promise<void> {
  const existing = await noteByHistory(item.id);
  if (existing) {
    // 与 openNoteForCard 同口径：打开已有笔记算一次阅读
    noteTouch(existing.id);
    useDialogStore.getState().openNote({
      noteId: existing.id,
      historyId: item.id,
      title: existing.title,
      content: existing.content,
    });
    return;
  }

  const url = (item.text ?? "").trim();
  // 12s 抓取窗 + 图片落盘的耗时窗内给一条即时反馈（U1：反馈 4s 默认不够）
  toast("正在抓取全文，多图文章可能要等十几秒…", "info", FETCH_TOAST_MS);
  try {
    const draft = await fetchArticleDraft(url);
    if (!draft) {
      toast("抓到的页面没有可读正文，可用「转为笔记」保存链接", "error");
      return;
    }
    useDialogStore.getState().openNote({
      historyId: item.id,
      title: draft.title,
      content: draft.content,
    });
    // 成功的反馈就是弹窗本身——正文已经看得见，不再补一条打扰的 toast
  } catch (e) {
    const detail = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
    toast(`抓取全文失败：${detail}。可用「转为笔记」保存已复制的内容`, "error");
  }
}

/**
 * AI 清洗成文（阶段 4，可选增强）：把内容喂给 `ai-kb-article` 去杂质，
 * 产出干净的 Markdown 文章初稿进 NoteDialog。
 *
 * 🔴 链接卡**先抓再洗**（2026-10-05 实测翻车）：链接卡的"文本"就是 URL 本身，
 * 直接喂给 AI 等于让它清洗一个链接（模型产出 `# https://…`）。所以链接卡
 * 先走与「抓取全文存知识库」同一条 fetchArticleDraft 拿到文章，再交给 AI 收尾；
 * AI 这一步失败/截断时，**抓到的本地全文照常交付**——十几秒的抓取不能白费。
 *
 * 🔴 幂等：与其它入口同口径，先回问后端，转过就打开已有笔记，
 * 绝不借 AI 入口建出第二份。
 *
 * 🔴 规则 16 双保险：前端入口只在 `isAiAvailable()`（总开关 + 有 key）时注入，
 * 后端 `ai_run` 校验 `cfg.enabled` + key；任何一边没开，这个函数就根本不会被调。
 *
 * 🔴 截断**不交付**：max_tokens 有限，长文会被截在半句——把半截稿子摆进
 * 编辑窗，用户会当成完整文章存进知识库（类型注释原文："界面必须说明，
 * 否则用户会把断在半句当成模型水平差"）。
 */
export async function aiComposeArticleForCard(item: HistoryItem, toast: ToastFn): Promise<void> {
  const existing = await noteByHistory(item.id);
  if (existing) {
    // 与 openNoteForCard 同口径：打开已有笔记算一次阅读
    noteTouch(existing.id);
    useDialogStore.getState().openNote({
      noteId: existing.id,
      historyId: item.id,
      title: existing.title,
      content: existing.content,
    });
    return;
  }

  // 链接卡：抓全文拿文章 MD，AI 只做收尾清洗
  let source = (item.text ?? "").trim();
  let fetchedDraft: { title: string; content: string } | null = null;
  if (isArticleCard(item)) {
    toast("正在抓取全文，多图文章可能要等十几秒…", "info", FETCH_TOAST_MS);
    try {
      const draft = await fetchArticleDraft(source);
      if (!draft) {
        toast("抓到的页面没有可读正文，可用「转为笔记」保存链接", "error");
        return;
      }
      fetchedDraft = draft;
      source = draft.content;
    } catch (e) {
      const detail = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
      toast(`抓取全文失败：${detail}。可用「转为笔记」保存已复制的内容`, "error");
      return;
    }
  }
  if (!source) return;

  toast("AI 清洗中，长文可能要等一会…", "info", AI_TOAST_MS);
  try {
    const r = await aiRun(AI_KB_ARTICLE, source);
    if (r.status === "ok" && r.content.trim() && !r.truncated) {
      useDialogStore.getState().openNote({
        historyId: item.id,
        // og:title 比 AI 自己拟的更可靠（AI 被要求拟标题，但源头标题更真）
        title: fetchedDraft?.title ?? titleFromContent(r.content),
        content: r.content,
      });
      return;
    }
    // 以下都是"AI 没给出可交付的成稿"：有本地全文的交本地全文（抓取不白费），
    // 没有的给退路提示。
    if (fetchedDraft) {
      const why =
        r.status !== "ok"
          ? r.status === "needsConfirm"
            ? r.reason
            : r.status === "budgetExceeded"
              ? "超出预算"
              : "AI 未产出内容"
          : "AI 清洗结果被截断";
      toast(`AI 清洗未完成（${why}），已放入未经清洗的全文`, "info");
      useDialogStore.getState().openNote({
        historyId: item.id,
        title: fetchedDraft.title,
        content: fetchedDraft.content,
      });
      return;
    }
    toast("AI 清洗未产出可用内容，可用「转为笔记」直接保存", "error");
  } catch (e) {
    const detail = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
    if (fetchedDraft) {
      toast(`AI 清洗失败（${detail}），已放入未经清洗的全文`, "info");
      useDialogStore.getState().openNote({
        historyId: item.id,
        title: fetchedDraft.title,
        content: fetchedDraft.content,
      });
      return;
    }
    toast(`AI 清洗失败：${detail}。可用「转为笔记」直接保存`, "error");
  }
}
