/**
 * 转笔记模板（B2 #8）。学 Obsidian Web Clipper，**只做变量替换**。
 *
 * 规划边界写死了：不上条件/循环/函数——那是 Templater 的路，属于 Reor 式铺宽。
 * 所以这里永远只会是一个 `String.replace`，不会长成模板引擎。
 *
 * **我们的变量比 Clipper 多且全自动**：它只有网页的 title/URL/Schema.org，
 * 而 `source`（来源应用）/ `content_type` / `tags` / OCR 文本 在采集时就已经算好入库。
 *
 * ❗ 规划里列的「原卡片链」**在当前架构里没有可用形态**：笔记靠 `history_id` 关联卡片，
 *   没有任何 URL 能写进 Markdown。改成 `{{origin}}`——一行人读的出处标注，
 *   因为用户真正想要的是「这段东西哪来的」，而不是一个点不动的 id
 *   （`extract.ts` 里已有的注释就是这个结论）。
 *
 * 🔴 红线：纯本地字符串处理，不调 AI、不联网。
 */
import type { HistoryItem } from "@/stores/appStore";
import { getContentTypeMeta } from "@/lib/contentTypes";
import type { NoteDraft } from "./extract";

/** 模板里可用的变量值。 */
export interface TemplateVars {
  /** 按类型抽出的正文（就是不套模板时的那个正文） */
  content: string;
  /** 按首行抽出的标题 */
  title: string;
  /** 来源应用名。可能为空（手动新建、或来源不可知） */
  source: string;
  /** 采集时间，原样。形如 `2026-09-01 14:32:07` */
  time: string;
  /** 仅日期部分 */
  date: string;
  /** 内容类型的**中文标签**（不是 `code`/`csv` 这种内部值） */
  contentType: string;
  /** 标签名，逗号分隔。无标签为空串 */
  tags: string;
  /** 图片的 OCR 文本。非图片为空串 */
  ocr: string;
  /** 一行出处标注，形如 `来自 Chrome · 2026-09-01 14:32` */
  origin: string;
}

/**
 * 模板占位符 → `TemplateVars` 的字段名。
 *
 * 占位符用 snake_case（与库里的字段名一致，用户看到 `{{content_type}}` 不会迷惑），
 * 而 TS 侧用 camelCase——两边不一致的那几个靠这张表桥接。
 */
const VAR_MAP: Record<string, keyof TemplateVars> = {
  content: "content",
  title: "title",
  source: "source",
  time: "time",
  date: "date",
  content_type: "contentType",
  tags: "tags",
  ocr: "ocr",
  origin: "origin",
};

/** 模板里合法的占位符名单（设置页列变量说明用，不另维护一份）。 */
export const TEMPLATE_VAR_NAMES = Object.keys(VAR_MAP);

/**
 * 把一张卡片 + 已抽好的初稿，算成模板变量。
 *
 * `contentType` 取**中文标签**而不是 `code`/`csv` 这种内部值：
 * 它是要写进笔记给人看的，`content_type: code` 在正文里没意义。
 * 走 `getContentTypeMeta`（卡片与第三栏用的同一份映射，规则 #11）。
 */
export function buildTemplateVars(item: HistoryItem, draft: NoteDraft): TemplateVars {
  const source = (item.source || "").trim();
  const time = item.time || "";
  // 时间戳形如 "2026-09-01 14:32:07"，出处行只要到分钟——秒对「这段哪来的」没意义
  const timeShort = time.slice(0, 16);
  const originParts = [source ? `来自 ${source}` : "", timeShort].filter(Boolean);

  return {
    content: draft.content,
    title: draft.title,
    source,
    time,
    date: time.slice(0, 10),
    contentType: getContentTypeMeta(item.content_type || item.type).label,
    tags: (item.tags ?? []).map((t) => t.name).join(", "),
    ocr: item.ocr_text ?? "",
    origin: originParts.join(" · "),
  };
}

/**
 * 套模板。
 *
 * **未知占位符原样保留**：笔记正文里真出现 `{{foo}}`（比如从别的模板系统
 * 拷来的一段）时不会被吃掉，也因此**不需要转义语法**。
 * 代价：用户拼错变量名（`{{sorce}}`）不会报错、会原文出现在笔记里——
 * 这比静默删掉一段文字好，而且设置页的实时预览里一眼就能看到。
 *
 * 占位符容忍内部空白（`{{ source }}`）与大小写。
 */
export function applyNoteTemplate(template: string, vars: TemplateVars): string {
  return template.replace(/\{\{\s*([A-Za-z_]+)\s*\}\}/g, (whole, name: string) => {
    const key = VAR_MAP[name.toLowerCase()];
    return key === undefined ? whole : vars[key];
  });
}

/**
 * 选模板（方案 B）：按 `content_type` 自动匹配，**不弹任何选择器**。
 *
 * 转笔记是高频动作，每次多一步点击就是给「低摩擦捕捉」让路。
 * `content_type` 是后端 `ContentClassifier` 入库时就算好持久化的，白拿的现成信号。
 */
export function pickTemplate(
  defaultTpl: string,
  overrides: Record<string, string>,
  contentType?: string,
): string {
  const key = (contentType || "").trim();
  // 覆盖是空串时视为「没配」而不是「配了个空模板」：
  // 设置页里用户把输入框清空，意图是「不特殊对待这个类型」，而不是「把正文清空」。
  const override = key ? (overrides[key] || "").trim() : "";
  return override || defaultTpl;
}

/**
 * 把初稿套成最终的笔记。模板为空 → **原样返回**。
 *
 * 空模板 = 不套，而不是套出一篇空笔记——这是默认值，也是向后兼容的保证：
 * 加了这个功能不能改变没配过模板的用户的转笔记结果。
 *
 * **只套正文，不套标题**：标题行就那么宽，往里塞 `来自 Chrome · 2026-09-01`
 * 只会把真正的标题挤成省略号。想把来源写进标题的需求可以后补，但不是默认。
 */
export function applyTemplateToDraft(
  draft: NoteDraft,
  item: HistoryItem,
  defaultTpl: string,
  overrides: Record<string, string>,
): NoteDraft {
  const tpl = pickTemplate(defaultTpl, overrides, item.content_type);
  if (!tpl.trim()) return draft;
  return { title: draft.title, content: applyNoteTemplate(tpl, buildTemplateVars(item, draft)) };
}

/** 解析存在 config 里的覆盖表（JSON 字符串）。脏值一律当空。 */
export function parseTemplateOverrides(raw: string | undefined): Record<string, string> {
  if (!raw || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "string") out[k] = val;
    }
    return out;
  } catch {
    // 脏值不报错也不阻断转笔记：最坏情况是退回默认模板，
    // 而不是「因为模板配置坏了所以转不了笔记」。
    return {};
  }
}

/**
 * 一份示例模板（设置页的「填入示例」按钮用）。
 *
 * **不当默认值**：默认必须是空（= 不套），否则升级后所有人的转笔记结果都变了。
 */
export const EXAMPLE_TEMPLATE = `> {{origin}}

{{content}}
`;
