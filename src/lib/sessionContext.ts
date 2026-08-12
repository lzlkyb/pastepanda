/**
 * lib/sessionContext.ts —— 工作记忆（v6.1）：会话桶。
 *
 * 把最近连续复制的几条内容按时间间隔聚成"一个任务"：
 * 你 90 秒内连着复制 3 段代码 → 它们是一个会话（"你在拼一个函数"）；
 * 复制完去干别的事，10 分钟后回来再复制 → 那是新会话。
 *
 * 红线：**纯内存态，不落盘、不出本机**——会话内容用完即弃，
 * 重启即清空，不写进任何数据库，也绝不上云。
 *
 * 消费方：SuggestionBar（会话感知建议：连续代码 → 建议 AI 合并）。
 */

/** 一个会话桶 */
export interface SessionBucket {
  /** 会话 id（起始时间戳） */
  id: number;
  /** 桶内内容（按复制顺序） */
  texts: string[];
  /** 每条的内容类型（与桶内容一一对应） */
  types: string[];
  /** 首条时间 */
  startedAt: number;
  /** 末条时间 */
  lastAt: number;
}

/** 超过这个间隔视为新会话 */
const GAP_MS = 90_000;
/** 桶内最多条数（超过开新桶，避免无限膨胀） */
const MAX_ITEMS = 8;
/** 合并时单条内容的截断长度（防拼接爆炸）。注意是**截断**而不是“不参与合并” */
const MAX_ITEM_CHARS = 4000;

/** 模块级会话（内存态） */
let bucket: SessionBucket | null = null;

/** 新复制内容进入会话桶 */
export function pushToSession(text: string, type: string): SessionBucket | null {
  const trimmed = (text || "").trim();
  if (!trimmed) return bucket;

  const now = Date.now();

  // 同内容连贴：**既不追加也不开新桶**，只刷新活跃时间（真去重）。
  //
  // 原实现把这个条件写在下面 `isNew` 的 OR 里，注释写的是“不算新会话”，
  // 但命中时 isNew 为 true —— 恰好**新建一个桶**，与注释完全相反。
  // 后果：A,B,B,C 这个序列本应得到 [A,B,C]，实际第二个 B 开了新桶 → 最后只剩
  // [B,C]，A 丢了。用户反复 Ctrl+C 同一段（很常见）就会静默截断工作记忆。
  // 既有测试只断言 length===1，两种行为都满足，所以一直维持绿色。
  if (
    bucket &&
    now - bucket.lastAt <= GAP_MS &&
    bucket.texts[bucket.texts.length - 1] === trimmed
  ) {
    bucket.lastAt = now;
    return bucket;
  }

  const isNew =
    !bucket ||
    now - bucket.lastAt > GAP_MS ||
    bucket.texts.length >= MAX_ITEMS;

  if (isNew) {
    bucket = { id: now, texts: [trimmed], types: [type], startedAt: now, lastAt: now };
  } else {
    // isNew 为 false ⇒ bucket 非空（新桶、间隔超限、超上限都会走 isNew）
    const b = bucket!;
    b.texts.push(trimmed);
    b.types.push(type);
    b.lastAt = now;
  }
  return bucket;
}

/** 当前活跃会话（无则 null） */
export function getSession(): SessionBucket | null {
  if (!bucket) return null;
  // 距最后一条太久 → 会话已过期，清掉
  if (Date.now() - bucket.lastAt > GAP_MS) {
    bucket = null;
    return null;
  }
  return bucket;
}

/** 重置会话（建议被使用/否决后调用） */
export function resetSession(): void {
  bucket = null;
}

/** 桶内是否全是同类（如全是代码）——会话感知建议的判据 */
export function isUniformType(b: SessionBucket, type: string): boolean {
  return b.texts.length >= 2 && b.types.every((t) => t === type);
}

/** 拼接桶内内容供 AI 合并（每段用 --- 分隔，截断超长条目） */
export function mergeSessionTexts(b: SessionBucket): string {
  return b.texts
    .map((t) => (t.length > MAX_ITEM_CHARS ? t.slice(0, MAX_ITEM_CHARS) : t))
    .join("\n\n---\n\n");
}

/** 仅供测试 */
export function __resetSessionForTest(): void {
  bucket = null;
}
