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

// ── P2 主题簇蒸馏 ────────────────────────────────────────────────
//
// 与 P1 的分工是**硬性**的，不是习惯：
//   P1 = 同一天 · 同来源同类型   → 「今天在 X 里复制的 N 条」
//   P2 = 跨天   · 同主题         → 「你三天里反复在碰 X 这件事」
// P2 **只出跨天的簇**（见 MIN_TOPIC_DAYS），否则它就是 P1 加了几步。

/**
 * 回看几天。
 *
 * 7 天 = 一个工作周。再长，「同一件事」的语义就开始漂
 * （两周前的那个 bug 和这周的那个 bug 只是名字像）。
 */
export const TOPIC_LOOKBACK_DAYS = 7;

/** 一簇至少要横跨几天。**这条是 P1/P2 的分界线，不能调成 1**。 */
export const MIN_TOPIC_DAYS = 2;

/** P2 每次最多出几篇。与 P1 分开计：两边都限量，合起来才不会淹。 */
export const MAX_TOPIC_DRAFTS = 2;

/**
 * 两段摘录算不算同一主题的阈值（重叠系数）。
 *
 * ⚠ 这个数没有第一性依据，**是实测挑的**。2026-09-08 在真库最近 7 天
 * （过滤占位后 344 条）上跑出来：
 *
 * | 阈值 | 跨天簇 | 最大簇 |
 * |---|---|---|
 * | 0.3 | 20 | 9 条 |
 * | **0.4** | **16** | **9 条** |
 * | 0.5 | 15 | 8 条 |
 * | 0.6 | 11 | 6 条 |
 *
 * 取 0.4：簇仍然成立（顶上是「sed 改 MCP 地址」9 条/4 天、
 * 「update aier633.IC_…」6 条/2 天，都是真在反复碰的事），
 * 而再高就开始把相关的也切散。
 *
 * 🔴 **第一版实测暴露过一个不是阈值能解决的问题**：图片占位串
 * （`[图片] 835x116`）彼此重叠度极高，被聚成一个 **48 条/8 天**的巨簇。
 * 当时的诱惑是把阈值调到 0.6 压住它——那是又一次「靠调阈值打补丁」。
 * 正确的修法是 `isPlaceholder` 把没有语义的挡在入口，见下。
 */
export const TOPIC_SIM = 0.4;

/**
 * 切词。中文按**二元组**，拉丁/数字按整词。
 *
 * 🔴 中文不能按空格切（没有空格），也不能按单字切（单字重叠率虚高，
 * 「的」「了」就能把两段毫不相干的话判成同一主题）。二元组是最便宜的可用粒度。
 */
export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  // 拉丁词与数字：长度 ≥ 2 才算，单字母是噪声
  for (const m of lower.matchAll(/[a-z0-9_]{2,}/g)) out.add(m[0]);
  // CJK 连续段 → 二元组
  for (const m of lower.matchAll(/[\u4e00-\u9fa5]+/g)) {
    const run = m[0];
    if (run.length === 1) continue; // 单字不进：它没有区分度
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

/**
 * 重叠系数 |A∩B| / min(|A|,|B|)，不是 Jaccard。
 *
 * ❗ 摘录长度差异很大（一条命令 vs 一段报错），Jaccard 会因为分母被长的那边
 * 撑大而把它们判成不相关；而它们**恰恰**常常是同一件事的两面。
 */
export function overlap(a: Set<string>, b: Set<string>): number {
  const min = Math.min(a.size, b.size);
  if (min === 0) return 0;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return hit / min;
}

/** `2026-09-08 14:03:22` → `2026-09-08`。 */
function dayOf(time: string): string {
  return time.slice(0, 10);
}

/**
 * 跨天主题簇。贪心：按时间顺序取种子，把够相似的收进来。
 *
 * 贪心而不是层次聚类：条目数是一周量级（几百），
 * 而层次聚类要 O(n²) 存距离矩阵 + 一堆合并策略参数——
 * 那些参数每一个都是又一个「没有依据的 0.4」。
 */
/**
 * 没有语义的占位摘录，**必须排除**。
 *
 * 🔴 这不是优化，是修一个实测出来的错误聚簇：图片卡片的 `text` 是
 * `[图片] 835x116` 这种占位串，彼此重叠度极高，实测被聚成一个
 * **48 条 / 8 天**的巨簇——那是「格式相同」，不是「主题相同」。
 *
 * ❗ 当时的诱惑是把阈值从 0.4 调到 0.6 压住它。那又是一次
 * 「靠调阈值打补丁」（截图通路#5 就是这么被判掉的）。
 * 正确的修法是**把没有语义的东西挡在入口**，而不是让阈值去背锅。
 */
function isPlaceholder(excerpt: string): boolean {
  const t = excerpt.trim();
  // `[图片] 835x116` / `[文件] xxx` 这类方括号前缀的占位
  if (/^\[[^\]]{1,6}\]/.test(t)) return true;
  // 纯尺寸、纯数字、纯符号：切完词几乎没有可比的东西
  if (!/[a-z0-9一-龥]/i.test(t)) return true;
  return false;
}

export function topicClusters(rows: DayExcerptRow[]): DayExcerptRow[][] {
  const usable = rows.filter((r) => r.excerpt.trim().length > 0 && !isPlaceholder(r.excerpt));
  const toks = usable.map((r) => tokenize(r.excerpt));
  const taken = new Array<boolean>(usable.length).fill(false);
  const clusters: DayExcerptRow[][] = [];

  for (let i = 0; i < usable.length; i++) {
    if (taken[i]) continue;
    const group = [i];
    taken[i] = true;
    for (let j = i + 1; j < usable.length; j++) {
      if (taken[j]) continue;
      if (overlap(toks[i], toks[j]) >= TOPIC_SIM) {
        taken[j] = true;
        group.push(j);
      }
    }
    const items = group.map((k) => usable[k]);
    const days = new Set(items.map((r) => dayOf(r.time)));
    // 🔴 两道闸一起把关：够多 且 跨天。少任何一道，P2 都会退化成 P1。
    if (items.length >= MIN_CLUSTER_SIZE && days.size >= MIN_TOPIC_DAYS) {
      clusters.push(items);
    }
  }
  return clusters.sort((a, b) => b.length - a.length);
}

/**
 * 把跨天主题簇拼成草稿。
 *
 * 标题取簇内**最高频的词**——比「主题 1 / 主题 2」有用得多，
 * 而且它天然就是这簇之所以成簇的那个词。
 */
export function buildTopicDrafts(
  rows: DayExcerptRow[],
  dismissed: ReadonlySet<string> = new Set(),
): DistillDraft[] {
  return topicClusters(rows)
    .map((items) => {
      const freq = new Map<string, number>();
      for (const r of items) {
        for (const t of tokenize(r.excerpt)) freq.set(t, (freq.get(t) ?? 0) + 1);
      }
      const top = [...freq.entries()]
        .filter(([t]) => t.length >= 2)
        // 同频时按字典序，保证同样的输入每次得到同样的标题
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
      const days = [...new Set(items.map((r) => dayOf(r.time)))].sort();
      const span = `${days[0]} ~ ${days[days.length - 1]}`;
      const label = top ?? "未命名主题";
      const lines = items
        .map((r) => `- ${dayOf(r.time)} ${hhmm(r.time)} ${r.excerpt}`)
        .join("\n");
      return {
        // key 带上跨度：明天再算时它会变，草稿也就该重新问一次
        key: `topic|${label}|${span}`,
        title: `${label} · ${days.length} 天里的 ${items.length} 条`,
        content: `这 ${days.length} 天（${span}）里反复出现的 **${label}**，共 ${items.length} 条：\n\n${lines}\n`,
        count: items.length,
        source: span,
        typeLabel: "跨天主题",
      };
    })
    .filter((d) => !dismissed.has(d.key))
    .slice(0, MAX_TOPIC_DRAFTS);
}
