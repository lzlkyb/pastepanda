/**
 * 每日蒸馏（P1）的纯函数层：把当天的剪贴板条目聚成几篇草稿。
 *
 * # 为什么是 N:1
 *
 * 一条剪贴板是个**片段**：半个命令、一段报错、一个链接。它很少自成一篇笔记。
 * 旧形态是「一条卡片 → 一篇笔记」，那不是蒸馏是**搬运**，注定量不起来。
 *
 * # 按什么聚
 *
 * `归一化后的来源` × `内容类型`。两个字段都现成，**零 AI**。
 * 文本相似度是 P2 的事，不在这里做——先用最便宜的依据验证形态能不能成立。
 *
 * # 🔴 三条红线在这里的体现
 *
 * 1. **不自动落库**——本模块只产出草稿对象，一个字也不写入。
 * 2. **不做全文搬运**——摄录已由**后端**夹到 60 字（`DISTILL_EXCERPT_CHARS`），
 *    前端拿不到全文，想搬也搬不了。
 * 3. **产出上限**——每天最多 [`MAX_DRAFTS_PER_DAY`] 篇。
 *    这一条是防 Collector's Fallacy 的**唯一机制**：
 *    Evernote / Pocket 都栽在「收集得越多越不看」上，
 *    Readwise 的答案是 **Daily Review（限量重现）**而不是更多收集。
 *    ❗ 靠调阀值压产量是补丁（通路#5 就是这么被判掉的），上限才是机制。
 */
import { cleanSourceName } from "@/lib/source-mappings";
import { getContentTypeMeta } from "@/lib/contentTypes";

/** 后端 `history_day_excerpts` 返回的一行。 */
export interface DayExcerptRow {
  id: string;
  /** `YYYY-MM-DD HH:MM:SS` */
  time: string;
  /** 原始窗口标题（**未归一化**）*/
  source: string;
  type: string;
  content_type: string | null;
  /** 后端夹好的 60 字摄录 */
  excerpt: string;
}

/** 一篇草稿。**只是对象，没落库**。 */
export interface DistillDraft {
  /** 稳定标识：`日期|来源|类型`。忽略时记的就是它 */
  key: string;
  title: string;
  /** Markdown 正文 */
  content: string;
  /** 构成本篇的卡片数 */
  count: number;
  /** 归一化后的来源名，展示用 */
  source: string;
  /** 中文类型名，展示用 */
  typeLabel: string;
}

/**
 * 每天最多产出几篇草稿。
 *
 * 3 不是拍的：少了没感觉（一篇容易恰好是你不想要的那篇），
 * 多了就是把「待沉淀」换成了「待阅读」——同一个坑换个名字。
 */
export const MAX_DRAFTS_PER_DAY = 3;

/**
 * 多少条才算一簇。
 *
 * 两条不是「一串」，只是碰巧挨在一起；而蒸馏的卖点就是「把散的收拢成一篇」，
 * 两条的草稿不比直接转其中一条强。
 */
export const MIN_CLUSTER_SIZE = 3;

/** `2026-09-08 14:03:22` → `14:03`。拿不准就返空串，不编。 */
function hhmm(time: string): string {
  const m = /\d{2}:\d{2}/.exec(time);
  return m ? m[0] : "";
}

/**
 * 把一天的条目聚成草稿。纯函数，无副作用。
 *
 * @param rows 当天条目（后端已按时间升序）
 * @param date `YYYY-MM-DD`，只用于拼标题与 key
 * @param dismissed 已被忽略的 key（当天不再提）
 */
export function buildDailyDrafts(
  rows: DayExcerptRow[],
  date: string,
  dismissed: ReadonlySet<string> = new Set(),
): DistillDraft[] {
  const buckets = new Map<string, DayExcerptRow[]>();
  for (const r of rows) {
    // ❗ 没摄录的直接丢：图片不带占位文本、空卡片都属于这类。
    // 把它们算进去只会拼出一堆空 bullet。
    if (!r.excerpt.trim()) continue;
    const src = cleanSourceName(r.source) || "（无来源）";
    const ct = r.content_type || r.type;
    const key = `${date}|${src}|${ct}`;
    const arr = buckets.get(key);
    if (arr) arr.push(r);
    else buckets.set(key, [r]);
  }

  return [...buckets.entries()]
    .filter(([key, items]) => items.length >= MIN_CLUSTER_SIZE && !dismissed.has(key))
    // 条数多的优先；同数时按 key 稳定排序（不稳定的话每次刷新顶三篇都在跳）
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, MAX_DRAFTS_PER_DAY)
    .map(([key, items]) => {
      const [, src, ct] = key.split("|");
      const typeLabel = getContentTypeMeta(ct).label;
      const lines = items.map((r) => `- ${hhmm(r.time)} ${r.excerpt}`).join("\n");
      return {
        key,
        title: `${src} · ${typeLabel} · ${date}`,
        // 开头那句是给**未来的你**看的：一篇只有 bullet 的笔记，
        // 三个月后根本想不起来当时为什么存它。
        content: `这一天在 **${src}** 里复制了 ${items.length} 条${typeLabel}：\n\n${lines}\n`,
        count: items.length,
        source: src,
        typeLabel,
      };
    });
}
