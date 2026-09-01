/**
 * 今日速记日历（B2 #3）的纯逻辑。
 *
 * 与组件分开是为了可测：月首星期几、跨年翻月、闰年二月这些分支
 * 靠看界面根本验不完。
 *
 * ⚠ **全程用本地时间，绝不碰 `toISOString()`**。后者转 UTC，
 * 东八区的 9 月 1 日 00:00 会变成 `2026-08-31`——日历上整体错一天，
 * 而且只在晚上八点后才能复现。
 */

/** 日历里的一格。 */
export interface CalCell {
  /** `YYYY-MM-DD` */
  date: string;
  /** 几号（1~31） */
  day: number;
  /** 是否当月（false = 上/下月的补位格，灰显） */
  inMonth: boolean;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 把 `Date` 格成 `YYYY-MM-DD`（本地时区）。 */
export function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `YYYY-MM-DD` → `YYYY-MM`。 */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** 月份平移。`shiftMonth("2026-01", -1)` → `"2025-12"`。 */
export function shiftMonth(monthKey: string, delta: number): string {
  const [y, m] = monthKey.split("-").map(Number);
  // 用 Date 而不是手算取模：跨年进位交给标准库，少一个自己写错的机会
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/**
 * 生成一个月的格子，**周一开头**，行数自适应（5 行或 6 行）。
 *
 * 不固定 42 格：大多数月份只需 5 行，固定 6 行会在侧栏里白吃掉一行高度。
 */
export function monthGrid(monthKey: string): CalCell[] {
  const [y, m] = monthKey.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  // JS 的 getDay() 周日=0；国内日历周一开头，所以 +6 再取模
  const lead = (first.getDay() + 6) % 7;
  // new Date(y, m, 0) = 上个月的最后一天，即本月天数（闰年二月也对）
  const days = new Date(y, m, 0).getDate();
  const total = Math.ceil((lead + days) / 7) * 7;

  const cells: CalCell[] = [];
  for (let i = 0; i < total; i++) {
    const d = new Date(y, m - 1, 1 - lead + i);
    cells.push({ date: fmtDate(d), day: d.getDate(), inMonth: d.getMonth() === m - 1 });
  }
  return cells;
}

/**
 * 能否往前翻。`earliest` 是最早一条速记的日期（没有速记时为 null）。
 *
 * 不做无限翻：往前翻到一个永远空白的 2019 年没任何意义，
 * 只会让用户以为自己把数据翻丢了。
 */
export function canGoPrev(monthKey: string, earliest: string | null): boolean {
  if (!earliest) return false;
  return monthKey > monthOf(earliest);
}

/** 能否往后翻。未来没有速记，所以本月就是头。 */
export function canGoNext(monthKey: string, todayDate: string): boolean {
  return monthKey < monthOf(todayDate);
}
