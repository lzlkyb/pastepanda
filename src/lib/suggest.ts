/**
 * lib/suggest.ts —— v6.2 主动建议（风险最高的一步，三条硬约束落实在组件层）：
 * 1. **绝不弹窗**：本模块只产出建议数据，由 SuggestionBar 在主窗口里以 inline 条展示；
 * 2. **只给 top-1**：永远只返回一个建议，不给列表；
 * 3. **一眼可否决**：组件层 ✕ → action_dismissals，否决被记住。
 *
 * 四种建议：
 * - **意图识别（V3-A）**：结合内容+场景推断「你在做什么」（排错/JSON/收集链接/
 *   批量/提炼/财务），给任务级建议（主动作 + 备选动作集）。置信度高才返回；
 * - **单条 top-1**：新内容命中 recommendScored 首位且分数足够高（≥ {@link TOP1_MIN_SCORE}），
 *   表示"这个内容你大概率要用某个动作"；
 * - **序列识别**：最近 3 条同类（如全是 IPv4 / 全是邮箱）→ "合并成 SQL IN"。
 *   变换本身早就有了，缺的是"注意到你在做一件多步的事"；
 * - **跑链建议（M4）**：当前内容命中某条预置链的第一步（如含 HTML → 「网页 → 纯文本」链、
 *   含手机号 → 「敏感信息脱敏」链）→ "用链一次跑完"。链 = 多步流水线，比单步更完整。
 */
import { recommendScored, type Scene } from "@/lib/recommend";
import type { TransformContext } from "@/lib/transforms";
import { PRESET_CHAINS, cachedUserChains } from "@/lib/chains/registry";
import { getTransform } from "@/lib/transforms";
import { detectIntent } from "@/lib/intent";

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
      kind: "intent";
      intentId: string;
      label: string;
      /** 动作集文案（如「解释代码 → 提取要点」） */
      actionsText: string;
      /** 建议动作（按优先级；第一个是主动作） */
      actionIds: string[];
      text: string;
    }
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
    }
  | {
      kind: "chain";
      chainId: string;
      label: string;
      text: string;
      /** 命中的是链的第几步（从 1 起，用于文案） */
      stepCount: number;
    };

/**
 * 意图识别建议（V3-A）：结合内容+场景推断「你在做什么」，给任务级建议。
 * 只在置信度足够高时返回（排错/JSON/批量 = 高置信，优先于单动作建议）。
 * 通过 {@link detectIntent} 实现，本函数只做类型包装与兜底。
 */
export function suggestIntent(
  ctx: TransformContext,
  scene?: Scene,
  recents?: { text: string }[],
): Suggestion | null {
  const intent = detectIntent(ctx, scene, recents);
  if (!intent) return null;
  return {
    kind: "intent",
    intentId: intent.id,
    label: intent.label,
    actionsText: intent.actionsText,
    actionIds: intent.actionIds,
    text: ctx.text,
  };
}

/** 单条 top-1 建议：当前内容最可能用的动作（分数不足返回 null）。
 *  scene 可选：提供「当前小时 + 来源应用」时启用场景感知（v6.2）。 */
export function suggestTop1(
  ctx: TransformContext,
  scene?: Scene,
): Suggestion | null {
  const top = recommendScored(ctx, scene)[0];
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

/**
 * 跑链建议（M4）：当前内容命中某条预置链的**第一步**（detect 高分）→ 建议用链一次跑完。
 * 链 = 多步流水线，比单步动作更完整（如 HTML 不只剥标签，还清空行）。
 * 只在 top-1 / 序列都没命中时兜底（宁可漏报不可误报，主动建议是打断）。
 */
export function suggestChain(ctx: TransformContext): Suggestion | null {
  let best: { chainId: string; label: string; steps: number; score: number } | null = null;
  // 自定义链排在前面：同分时用户亲手配的链胜出（下面用的是严格大于）。
  // 不加这一句的后果：用户花功夫建了链，却永远只被推荐我们自带的预置链。
  for (const chain of [...cachedUserChains(), ...PRESET_CHAINS]) {
    const first = getTransform(chain.steps[0].transformId);
    if (!first) continue;
    const score = first.detect(ctx);
    if (score >= CHAIN_MIN_SCORE && (!best || score > best.score)) {
      best = { chainId: chain.id, label: chain.name, steps: chain.steps.length, score };
    }
  }
  if (!best) return null;
  return {
    kind: "chain",
    chainId: best.chainId,
    label: best.label,
    text: ctx.text,
    stepCount: best.steps,
  };
}

/** 跑链建议的最低第一步分数。同 top-1：宁可漏报不可误报。 */
export const CHAIN_MIN_SCORE = 0.6;
