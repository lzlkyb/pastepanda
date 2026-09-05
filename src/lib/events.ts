/**
 * lib/events.ts —— 把时间上相邻的剪贴板条目聚成「段」。
 *
 * # 一个函数，两个消费方
 *
 * - **每日整理（H3）**：一天的段列表就是那天的时间线；
 * - **事件聚合（G3）**：每个段是搜索栏里的一个「事件」。
 *
 * 两边各写一套分段逻辑就会漂（同一天的数据在两处分出不同段数，而没人能解释为什么），
 * 所以收口在这里（规则 #11）。
 *
 * # 纯函数
 *
 * 不碰 IO、**不取当前时间**。取了的话「今天/昨天」这类相对日期逻辑就只能靠真实时钟测，
 * 永远写不出稳定的用例（设计稿 §5）。
 *
 * # 只看五列
 *
 * `id / time / source / type / content_type`。**不碰 `text` 与 `content`**——
 * 聚合只需要元信息，而图片的 `content` 是 base64，拉出来是白花内存。
 * 这同时也是隐私约束：每日整理的行为层零内容出网。
 */
import { cleanSourceName } from "@/lib/utils";

/**
 * 分段阈值（秒）。相邻两条间隔**超过**它就断段。
 *
 * 写死，**不开设置项**。本机 540 条真实数据的间隔分布：中位 168 秒、p90 1862 秒；
 * 按不同阈值分段：5 分钟→ 2.7 条/段（太碎）、10 分钟→ 3.6、15 分钟→ 5.0（可用）、
 * **20 分钟→ 6.1（选它，正好是「调一个接口用了几段」的粒度）**、
 * 30 分钟→ 9.6（开始把不相关的事揉在一起）、60 分钟→ 18.6（失去意义）。
 *
 * 不开设置项的理由：用户无法判断「20 分钟」对不对，
 * 把一个没人能回答的参数丢给用户不是灵活是推责。
 */
export const EVENT_GAP_SECS = 1200;

/** 分段所需的最小条目形状（就是后端只查的那五列）。 */
export interface SegmentItem {
  id: string;
  /** `YYYY-MM-DD HH:MM:SS`（可能带毫秒）。 */
  time: string;
  /** 原始 `source`——**存的是完整窗口标题**，不是 App 名。 */
  source: string;
  type: string;
  content_type: string | null;
}

/** 一段。 */
export interface Segment {
  /** `HH:MM`。 */
  startTime: string;
  /** `HH:MM`；单条段时与 `startTime` 相同。 */
  endTime: string;
  /** 段内出现最多的来源，**已过 `cleanSourceName`**。 */
  topSource: string;
  /** 按次数降序的类型计数。 */
  typeCounts: { type: string; count: number }[];
  /** 段内条目，按时间升序。 */
  items: SegmentItem[];
}

/** `"2026-09-04 09:20:01"` → 毫秒数；解不出来返 `NaN`。 */
function parseTime(s: string): number {
  // 手拆而不是 `new Date(s)`：后者对 `"2026-09-04 09:20:01"` 这种带空格的写法
  // 在不同引擎上行为不一致（Safari 直接返 Invalid Date）。
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return NaN;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

/** `"2026-09-04 09:20:01"` → `"09:20"`。 */
function hhmm(s: string): string {
  return s.slice(11, 16);
}

/**
 * 按时间间隔把条目分段。
 *
 * @param items 任意顺序——**内部会先排升序**。
 *   列表接口返的是降序，不排的话相邻差全是负数，永远不会断段。
 * @param gapSecs 阈值秒数；间隔**大于**它才断。刚好等于不断（边界已配单测）。
 */
export function segmentByGap(items: SegmentItem[], gapSecs: number): Segment[] {
  // 时间解不出来的直接丢掉。NaN 参与比较永远为 false，
  // 留着会让它后面所有条目都接不上段——静默地把整天揉成一段。
  const sorted = items
    .map((it) => ({ it, t: parseTime(it.time) }))
    .filter((x) => !Number.isNaN(x.t))
    .sort((a, b) => a.t - b.t);
  if (sorted.length === 0) return [];

  const gapMs = gapSecs * 1000;
  const groups: SegmentItem[][] = [];
  let cur: SegmentItem[] = [sorted[0].it];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].t - sorted[i - 1].t > gapMs) {
      groups.push(cur);
      cur = [];
    }
    cur.push(sorted[i].it);
  }
  groups.push(cur);

  return groups.map((g) => {
    // 主来源必须先归一化再计数：`source` 存的是完整窗口标题，
    // 同一个 App 的不同窗口（`a.java - Eclipse IDE` / `b.java - Eclipse IDE`）
    // 是不同字串，不归一化就会把一个 App 数成好几个、选错主来源。
    const srcCount = new Map<string, number>();
    for (const it of g) {
      const name = cleanSourceName(it.source ?? "");
      srcCount.set(name, (srcCount.get(name) ?? 0) + 1);
    }
    const topSource = [...srcCount.entries()].sort((a, b) => b[1] - a[1])[0][0];

    const typeCount = new Map<string, number>();
    for (const it of g) {
      typeCount.set(it.type, (typeCount.get(it.type) ?? 0) + 1);
    }

    return {
      startTime: hhmm(g[0].time),
      endTime: hhmm(g[g.length - 1].time),
      topSource,
      typeCounts: [...typeCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => ({ type, count })),
      items: g,
    };
  });
}
