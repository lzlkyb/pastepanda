/**
 * 星标自动沉淀（「文章 → 知识库」阶段 3，L2 档）。
 *
 * 🎯 该自动的是「沉淀信号」，不是「复制行为」：只有用户**点亮星标**（置顶）
 * 且在设置里打开 `kb_auto_deposit`（默认关）时才动，产物是**草稿**
 * （`notes.auto_deposited = 1`），等用户在知识库里「转正/丢弃」——
 * 误判成本为零（两级取消原则），知识库不会被复制流灌成垃圾场。
 *
 * 🔴 收口（规则 #11.1）：全项目「点亮星星」的动作只有一条路——
 * {@link togglePinAndDeposit}。Card 的三处星标与 App 的 Ctrl+D 全部走它，
 * 谁直接调 `togglePin` 谁就是在绕过自动沉淀。
 *
 * 反馈编排也收在这里（U1/U3）：每次星标动作**只发一条 toast**，由
 * {@link togglePinAndDeposit} 按 {@link depositCardOnStar} 的结构化结果合成——
 * 「已置顶」与「已自动沉淀」拆成两条连发，用户读到的就是两件事。
 *
 * 🔴 红线：纯本地管线（extractNoteDraft → 模板 → SQLite），不调 AI、不联网。
 * 唯一的例外是链接卡片走 `fetch_url_article` 抓全文——那是用户点亮了一篇
 * 「文章链接」且自己开了开关，与手动点「抓取全文存知识库」是同一个动作。
 */
import type { HistoryItem } from "@/stores/appStore";
import type { ImageOcrState } from "@/lib/utils";
import type { ToastFn } from "@/components/Toast";
import { useAppStore } from "@/stores/appStore";
import { togglePin, noteByHistory } from "@/lib/api";
import { noteCreateAuto } from "@/lib/api/notes";
import { buildCardDraft } from "./open";
import { isArticleCard, fetchArticleDraft } from "./article";

export type DepositStatus =
  | "deposited" // 已建成草稿
  | "existing" // 这张卡片已有笔记（幂等命中）
  | "skipped" // 开关没开（最常见的静默路径）
  | "skipped_content" // 开关开着，但这内容没有可沉淀的正文（file 卡/无 OCR 图片）
  | "failed"; // 想沉淀但失败了，`detail` 说明原因

export interface DepositResult {
  status: DepositStatus;
  /** status = "failed" 时的人话原因（后端错误或无正文） */
  detail?: string;
}

/**
 * 星标切换 + （开关开着时）自动沉淀。Card 三处星标与 App Ctrl+D 的唯一入口。
 *
 * 置顶本身的成败沿用手动置顶的原口径：togglePin 返 null → 报错 toast。
 * 沉淀发生在置顶**成功且确实置顶**之后；结果合成**一条** toast（见上）。
 */
export async function togglePinAndDeposit(
  item: HistoryItem,
  ocrState?: ImageOcrState,
  toast?: ToastFn,
): Promise<void> {
  const pinned = await togglePin(item.id);
  if (pinned === null) {
    toast?.("置顶操作失败", "error");
    return;
  }
  if (!pinned) {
    toast?.("已取消置顶", "success");
    return;
  }
  const r = await depositCardOnStar(item, ocrState);
  switch (r.status) {
    case "deposited":
      toast?.("已置顶，并自动沉淀为草稿", "success");
      break;
    case "existing":
      toast?.("已置顶（该卡片已有笔记）", "success");
      break;
    case "skipped":
      toast?.("已置顶", "success");
      break;
    case "skipped_content":
      // 不是失败：置顶成功了，但这条内容本来就没有正文可转。说明一句，
      // 用户就不用猜「开了开关怎么没进知识库」（规则 15.3）。
      toast?.("已置顶（该内容没有可沉淀的正文，未自动沉淀）", "success");
      break;
    case "failed":
      toast?.(`已置顶，但自动沉淀失败：${r.detail ?? "未知原因"}`, "error");
      break;
  }
}

/**
 * 星标命中后的自动沉淀。守卫按序过；「开关没开」是静默返回——
 * 那是绝大多数星标的日常路径，弹提示反而是骚扰。
 */
export async function depositCardOnStar(
  item: HistoryItem,
  ocrState?: ImageOcrState,
): Promise<DepositResult> {
  // ① 总开关。默认关，老用户自己打开才算授权自动化。
  if (!useAppStore.getState().config.kb_auto_deposit) return { status: "skipped" };

  // ② 幂等。与手动转笔记同一口径：先回问后端，转过就绝不再建第二份。
  //    放在抓取**之前**：链接卡已转过时不必白抓十几秒。
  const existing = await noteByHistory(item.id);
  if (existing) return { status: "existing" };

  // ③ 链接卡走抓全文（与手动「抓取全文存知识库」同一份 fetchArticleDraft）：
  //    用户点亮的是一篇文章链接，草稿就该是文章，而不是裸链接字符串。
  if (isArticleCard(item)) {
    try {
      const draft = await fetchArticleDraft((item.text ?? "").trim());
      if (!draft) return { status: "failed", detail: "页面没有可读正文" };
      return await createAutoDraft(item.id, draft.title, draft.content);
    } catch (e) {
      const detail = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
      return { status: "failed", detail };
    }
  }

  // ④ 普通卡片走与手动转笔记同一条抽取管线：file 卡 / 无 OCR 图片 /
  //    空文本在这里就是 null（与待沉淀区排除口径一致），不产生空笔记。
  const final = buildCardDraft(item, ocrState);
  if (!final) return { status: "skipped_content" };
  return createAutoDraft(item.id, final.title, final.content);
}

/** 落库 + 计数（手动/链接抓取两条路共用的一段尾巴）。 */
async function createAutoDraft(
  historyId: string,
  title: string,
  content: string,
): Promise<DepositResult> {
  const note = await noteCreateAuto(historyId, title, content);
  if (!note) return { status: "failed", detail: "写入知识库失败" };
  // 反馈（规则 15.1）：卡片 📝 角标（api 层已同步）+ 知识库待确认计数 +1。
  // toast 由 togglePinAndDeposit 按返回值合成，这里不发。
  const s = useAppStore.getState();
  s.setAutoDepositCount(s.autoDepositCount + 1);
  return { status: "deposited" };
}
