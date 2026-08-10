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
 * 通过 {@link detectIntent} 实现，本函数做类型包装 + **注册表校验**。
 *
 * ## 为什么这里必须查注册表（不要当成多余的检查删掉）
 *
 * {@link detectIntent} 是**纯规则**函数，它写死的 actionIds 里有相当一部分是
 * AI 动作（ai-explain-code / ai-key-points / ai-json-to-type / url-summary /
 * ai-summarize / ai-polish / ai-tabulate）。这些动作定义在后端 Rust
 * （src-tauri/src/ai/actions.rs），**运行时**才由 transforms/aiTransforms.ts 调
 * registerTransform() 注册进前端注册表——AI 未启用 / 未配置 API Key 时，
 * 它们根本不在表里。而 detectIntent 不查注册表。
 *
 * 于是会出现「承诺了做不到的事」：复制一段含报错字样的内容 → 建议条显示
 * 「看起来你在排错 · 解释代码 → 提取要点」→ 点「使用」打开变换枢纽 →
 * 枢纽里没有「解释代码」这张卡片。不崩溃，但是骗人。更糟的是
 * 「AI 未配置」正是**新用户的默认状态**，也就是第一印象。
 *
 * 意图是唯一一条**绕过注册表**的建议来源（{@link suggestTop1} 走
 * recommendScored，候选本来就是从注册表算出来的；{@link suggestChain} 也已经
 * 用 getTransform 过滤过第一步），所以这道校验只能补在这里。补在这里而不是
 * 组件里，还顺带同时修好两个调用方：SuggestionBar（主窗口）与
 * TrayPopupSuggestion（托盘弹窗）复用本函数。
 */
export function suggestIntent(
  ctx: TransformContext,
  scene?: Scene,
  recents?: { text: string }[],
): Suggestion | null {
  const intent = detectIntent(ctx, scene, recents);
  if (!intent) return null;

  // 主动作（actionIds[0]）= 建议条文案承诺的那个动作，也是两个调用方点「使用」时
  // 唯一真正执行的动作。它不在注册表里 → 整个意图作废，宁可不给建议。
  //
  // 有意**不做**「主动作没了就让备选顶上」的降级：actionsText（如
  // 「解释代码 → 提取要点」）是 intent.ts 里按意图手写的整句文案，没法按 id 拆改，
  // 顶替之后界面说的仍然不是实际能做的——那只是换一种方式说谎。
  //
  // 同理**也不过滤备选动作**：备选在文案里没有可单独裁掉的片段，过滤只会让
  // actionsText 与 actionIds 更不一致；且当前两个调用方都只读 actionIds[0]，
  // 过滤备选没有任何用户可见收益。保持简单：只校验主动作。
  if (!getTransform(intent.actionIds[0])) return null;

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
 *
 * 同 {@link suggestIntent}，这里也有一道注册表校验，但要求更强：
 * **链的每一步都必须在注册表里**，缺任何一步整条链不推（详见循环内注释）。
 */
export function suggestChain(ctx: TransformContext): Suggestion | null {
  let best: { chainId: string; label: string; steps: number; score: number } | null = null;
  // 自定义链排在前面：同分时用户亲手配的链胜出（下面用的是严格大于）。
  // 不加这一句的后果：用户花功夫建了链，却永远只被推荐我们自带的预置链。
  for (const chain of [...cachedUserChains(), ...PRESET_CHAINS]) {
    // 空步骤链无从跑起（自定义链来自后端 chain_defs 表，不保证非空），
    // 顺手挡掉；也避开下面 steps[0] 读到 undefined 直接抛异常。
    if (chain.steps.length === 0) continue;

    const first = getTransform(chain.steps[0].transformId);

    // **要求每一步都能在注册表里解析出来，缺任何一步整条链跳过。**
    //
    // 为何不是只校验第一步：第一步的 detect() 回答的是「这条链适不适用于
    // 当前内容」（下面拿它打分），而「这条链能不能跑完」需要每一步都在——
    // 这是两件事，旧代码只查 steps[0] 是把它们误当成了一件。
    //
    // 触发场景：自定义链允许包含 AI 步骤，而 AI 动作是**运行时**注册的
    // （理由同 {@link suggestIntent} 那段注释）。用户在 AI 可用时建了一条
    // 第 2 步是 AI 的链，之后没配 Key / 关掉了 AI：第一步是本地变换，照样命中、
    // 链照样被推荐，点下去跑到中段才失败（runChain 会在该步返回
    // 「变换不存在（未注册）」）。建议条承诺的是「用链一次跑完」，
    // 那就得先确认真能跑完。
    //
    // 有意**不做**「跳过缺失的那步继续跑」：那样实际执行的流水线与链名
    // 承诺的不一致（比如「敏感信息脱敏」少跑了脱敏那一步，还自称跑完了），
    // 属于换一种方式说谎——与 suggestIntent 对主动作的取舍保持一致。
    if (!first || chain.steps.some((s) => !getTransform(s.transformId))) continue;

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
