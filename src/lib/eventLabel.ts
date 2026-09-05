/**
 * lib/eventLabel.ts —— 事件聚合（G3）的标签与筛选值。
 *
 * ⚠ **2026-09-05 后本文件分成了两半**，新增代码前先看清楚：
 * - `isEventRange` / `parseEventRange` —— **在用**，支撑 `range:` 筛选路径
 *   （`App.tsx` 搜索编排守卫、`appStore` 的内存筛选）；
 * - `eventLabel` / `eventRangeValue` —— **目前只被单测调到**。顶栏的事件下拉
 *   已撤（理由见 `TopBar.tsx` 里那段注释），保留它俩是因为把这个能力
 *   挪进「今日整理」时直接就能用（相对日期、秒级区间值这两块不好重写）。
 *   若确定不挪了，连同用例一起删，别就这么挂着。
 *
 * 分段本身在 `lib/events.ts`（与每日整理共用），这里只管「怎么把一段写成一条下拉项」。
 *
 * # 标题取格式 A：`起止时间 · 来源 · 条数`
 *
 * 设计稿在真实数据上比过三种写法，选 A 的理由：
 * 起止时间本身就含时长信息，而「下午三点多那阵」是人找东西的主锚点。
 * 格式 C（来源 · 内容 · 时长）丢了绝对时间，而那正是本功能的主场景。
 *
 * 顺带说明：A 不写内容类型，所以设计稿 §3 ③ 那个「流程图 · 4 条流程图 · 流程图」
 * 的重复问题在这里不存在（那是格式 C 才有的）。
 */
import type { Segment } from "@/lib/events";

/** `"2026-09-04 09:20:01"` → `"2026-09-04"`。 */
function dayOf(time: string): string {
  return time.slice(0, 10);
}

/** `Date` → `"YYYY-MM-DD"`（本地时区）。 */
function isoOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 一条事件的下拉文字。
 *
 * # 相对日期（设计稿 §3 ④，拿真实数据跑出来才发现的）
 *
 * 今天只写时间、昨天写「昨天」、更早写日期。
 * 给今天的事件加日期前缀是纯噪音——下拉里大多数项都是今天的。
 *
 * @param now **必传**。不在里面取 `new Date()`：那样跨午夜跑测试会间歇红，
 *   而且无法构造「昨天」这种场景。
 */
export function eventLabel(s: Segment, now: Date): string {
  const day = dayOf(s.items[0].time);
  const today = isoOf(now);
  const yesterday = isoOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));

  let prefix = "";
  if (day === today) {
    prefix = "";
  } else if (day === yesterday) {
    prefix = "昨天 ";
  } else {
    // 不写年：下拉宽度有限，而跨年找东西不是本功能的场景
    const [, m, d] = day.split("-");
    prefix = `${Number(m)}-${d} `;
  }

  const time = s.startTime === s.endTime ? s.startTime : `${s.startTime}-${s.endTime}`;
  return `${prefix}${time} · ${s.topSource} · ${s.items.length} 条`;
}

/**
 * 一条事件对应的筛选值：`range:<起>~<止>`。
 *
 * ❗ 用的是 `items` 里的**秒级原始时间**，不是展示用的 `startTime`/`endTime`（HH:MM）。
 * 拿 HH:MM 去筛会把首尾那一分钟内的条目漏掉或多包进来。
 * `items` 已由 `segmentByGap` 保证按时间升序。
 */
export function eventRangeValue(s: Segment): string {
  return `range:${s.items[0].time}~${s.items[s.items.length - 1].time}`;
}

/**
 * 当前筛选是不是一个事件范围。
 *
 * 🔴 它决定的不只是显示：无关键词时列表只筛**内存里已加载的那一窗口**
 * （初始 50 条，靠滚动分页长），而后端全量查询原本只在有关键词时触发。
 * 选一个三天前的事件时，内存里根本没那批条目——所以事件筛选必须与关键词
 * 一样触发后端查询（见 `App.tsx` 搜索编排与 `getFilteredItems`）。
 */
export function isEventRange(v: string): boolean {
  return parseEventRange(v) !== null;
}

/**
 * 解筛选值；不是 `range:` 开头或残缺时返 `null`。
 */
export function parseEventRange(v: string): { start: string; end: string } | null {
  if (!v.startsWith("range:")) return null;
  const body = v.slice("range:".length);
  const i = body.indexOf("~");
  if (i <= 0 || i === body.length - 1) return null;
  return { start: body.slice(0, i), end: body.slice(i + 1) };
}
