/**
 * lib/suggest.ts —— v6.2 主动建议（风险最高的一步，三条硬约束落实在组件层）：
 * 1. **绝不弹窗**：本模块只产出建议数据，由 SuggestionBar 在主窗口里以 inline 条展示；
 * 2. **只给 top-1**：永远只返回一个建议，不给列表；
 * 3. **一眼可否决**：组件层 ✕ → action_dismissals，否决被记住。
 *
 * 两种建议：
 * - **单条 top-1**：新内容命中 recommendScored 首位且分数足够高（≥ {@link TOP1_MIN_SCORE}），
 *   表示"这个内容你大概率要用某个动作"；
 * - **序列识别**：最近 3 条同类（如全是 IPv4 / 全是邮箱）→ "合并成 SQL IN"。
 *   变换本身早就有了，缺的是"注意到你在做一件多步的事"。
 */
import { recommendScored } from "@/lib/recommend";
import type { TransformContext } from "@/lib/transforms";

/**
 * top-1 建议的最低分数。**宁可漏报不可误报**（主动建议是打断，做错一次用户就永久关掉）：
 * 0.6 档会有「Unicode 编码」这类对任何文本都命中的通用变换混进来——
 * 那不是"你大概率要用"，是"什么都能用"。0.75 只放行高判别力动作
 * （sql-in / json-insert / AI / 执行类）。
 */
export const TOP1_MIN_SCORE = 0.75;

/** 序列识别至少需要几条同类记录 */
export const SEQUENCE_MIN_COUNT = 3;

/** IPv4 地址（粗匹配，与 actionTransforms 一致） */
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** 单个邮箱 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 一条建议 */
export type Suggestion =
  | {
      kind: "action";
      transformId: string;
      label: string;
      text: string;
      score: number;
    }
  | {
      kind: "sequence";
      transformId: string;
      label: string;
      texts: string[];
      /** 合并后的输入（如 JSON 数组），供变换 run / 枢纽使用 */
      mergedText: string;
    };

/** 单条 top-1 建议：当前内容最可能用的动作（分数不足返回 null） */
export function suggestTop1(ctx: TransformContext): Suggestion | null {
  const top = recommendScored(ctx)[0];
  if (!top || top.score < TOP1_MIN_SCORE) return null;
  return {
    kind: "action",
    transformId: top.transform.id,
    label: top.transform.label,
    text: ctx.text,
    score: top.score,
  };
}

/** 最近的同类记录（按时间倒序传入，取前 N 条，要求全部同类） */
export function suggestSequence(
  recent: { text: string }[],
): Suggestion | null {
  if (recent.length < SEQUENCE_MIN_COUNT) return null;
  const head = recent.slice(0, SEQUENCE_MIN_COUNT);
  const texts = head.map((h) => h.text.trim());
  if (texts.some((t) => !t)) return null;

  // 3 个 IPv4 → SQL IN（路线图 v6.2 的原型场景）
  if (texts.every((t) => IPV4_RE.test(t))) {
    return {
      kind: "sequence",
      transformId: "sql-in",
      label: "SQL IN",
      texts,
      mergedText: JSON.stringify(texts),
    };
  }
  // 3 个邮箱 → SQL IN（同类多值的常见场景）
  if (texts.every((t) => EMAIL_RE.test(t))) {
    return {
      kind: "sequence",
      transformId: "sql-in",
      label: "SQL IN",
      texts,
      mergedText: JSON.stringify(texts),
    };
  }
  return null;
}
