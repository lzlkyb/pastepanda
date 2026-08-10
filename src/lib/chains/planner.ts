/**
 * chains/planner.ts —— AI 编链（B）的**解析与校验**层。
 *
 * 模型输出一个 step 列表，这里负责把它变成一条可执行的 {@link Chain}。
 * 两件事而已：**容错地把 JSON 抠出来**，然后**不信任它说的任何一个字**。
 *
 * ## 为什么不用 response_format / function calling
 *
 * 编排的输出很小（就是个 id 列表），容错解析足够；而**白名单校验无论哪个方案都必做**
 * ——JSON 模式只能保证“是合法 JSON”，保证不了“里面的 id 真存在”。
 * 模型完全可能自信地编一个 `ai-fix-my-bug` 出来。
 *
 * ## 三条安全红线
 *
 * 1. **transformId 必须过注册表白名单**，不在表里的一律丢弃；
 * 2. **risk 不采信模型的说法**，一律本地从变换自身属性推导（{@link riskOf}）。
 *
 *    注意别把这条当成发送门禁：实际拦住“内容出网”的是 `runChain` 里的
 *    `if (t.remote)` + 默认拒绝，**和 step.risk 无关**——step.risk 在执行器里
 *    只被写进 `stages` 做展示。所以模型就算把联网步骤填成 `local`，也绕不过确认。
 *    真正的危害是**安全提示说谎**：ChainRunnerDialog 会把含 AI 步骤的链显示成
 *    “全部本地变换”，用户据此判断要不要跑——这一条已经足够让 risk 必须准确。
 * 3. **执行类变换（`kind === "action"`）一律不收**。它们产生副作用（开浏览器 /
 *    开资源管理器 / 起 mailto）而不产出文本。ChainEditor 给人选的时候就已经排除了它们
 *    （“流水线里夹一个打开浏览器”），而这里的输入来自模型，更不能放。
 *
 * 编出来的链**仍然要用户点确认才跑**（红线①：学习只影响排序，永不自动执行）。
 */

import { getTransform } from "@/lib/transforms";
import { riskOf } from "@/lib/chains/registry";
import type { Chain, ChainStep } from "@/lib/chains/types";

/**
 * 编出来的链最多几步。
 *
 * 6 是上限而非目标：超过这个数的流水线用户根本看不过来，而“看得过来”是确认环节的前提。
 * 模型一旦开始堆步骤，往往是它自己也不确定。
 */
export const MAX_PLANNED_STEPS = 6;

/** 链名 / 说明的长度上限（模型爱写长句子，界面放不下） */
const MAX_NAME_CHARS = 24;
const MAX_DESC_CHARS = 80;

/** 解析结果 */
export interface PlannedChain {
  name: string;
  description: string;
  steps: ChainStep[];
  /**
   * 模型给了、但不在注册表里被丢弃的 id。
   *
   * **要告诉用户**：静默丢弃会让人以为模型就是这么编的，
   * 而它实际上想做一些我们没有的事——那是产品信号，不是噪声。
   */
  dropped: string[];
}

/** 把一段可能包着 ```json 围栅 / 夹着散文的文本里的第一个 JSON 对象抠出来。 */
function extractJsonObject(raw: string): unknown | null {
  let s = raw.trim();

  // 剥 ``` 围栅（```json … ``` 或 ``` … ```）
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  // 取第一个 { 到最后一个 }——容得下模型在前后多说两句
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first < 0 || last <= first) return null;

  try {
    return JSON.parse(s.slice(first, last + 1));
  } catch {
    return null;
  }
}

/** 从一个步骤项（可能是字符串，也可能是字段名各异的对象）里取出 id。 */
function stepIdOf(item: unknown): string {
  if (typeof item === "string") return item.trim();
  if (item && typeof item === "object") {
    const o = item as Record<string, unknown>;
    // 字段名漂移是常态：叫什么的都有，只要能拿到 id 就行
    for (const k of ["transformId", "id", "action", "actionId", "transform", "step"]) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return "";
}

/** 从解析出的对象里找步骤数组（字段名同样容错）。 */
function stepsArrayOf(obj: Record<string, unknown>): unknown[] {
  for (const k of ["steps", "plan", "chain", "actions", "pipeline"]) {
    const v = obj[k];
    if (Array.isArray(v)) return v;
  }
  return [];
}

/** 取字符串字段并限长（模型可能不给，也可能给一整段） */
function str(obj: Record<string, unknown>, keys: string[], max: number, fallback: string): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) {
      const t = v.trim().replace(/\s+/g, " ");
      return t.length > max ? t.slice(0, max) : t;
    }
  }
  return fallback;
}

/**
 * 解析 + 校验模型返回的链。
 *
 * @param raw 模型原始文本（后端已去过 `<think>`，这里再剥一层 ``` 围栅）
 * @returns 解析失败、或**一步合法步骤都没有**时返回 null（此时不该给用户看任何东西）
 */
export function parseChainPlan(raw: string): PlannedChain | null {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  const steps: ChainStep[] = [];
  const dropped: string[] = [];

  for (const item of stepsArrayOf(obj)) {
    if (steps.length >= MAX_PLANNED_STEPS) break;

    const id = stepIdOf(item);
    if (!id) continue;

    // 白名单：不在注册表里的一律丢，并记下来告诉用户
    const t = getTransform(id);
    if (!t) {
      if (!dropped.includes(id)) dropped.push(id);
      continue;
    }

    // 执行类同样丢弃（见顶部红线 3）——它们不产出文本，放进链里等于
    // 让模型编的计划直接产生副作用
    if (t.kind === "action") {
      if (!dropped.includes(id)) dropped.push(id);
      continue;
    }

    // 连续重复的同一步骤没意义（模型偶尔会把同一个 id 连写两遍）
    if (steps.length > 0 && steps[steps.length - 1].transformId === t.id) continue;

    // risk 本地推导——模型即使在 JSON 里写了 risk 也一律忽略（见顶部红线 2）
    steps.push({ transformId: t.id, risk: riskOf(t) });
  }

  if (steps.length === 0) return null;

  return {
    name: str(obj, ["name", "title", "chainName"], MAX_NAME_CHARS, "AI 编的链"),
    description: str(obj, ["description", "desc", "summary", "why"], MAX_DESC_CHARS, ""),
    steps,
    dropped,
  };
}

/** 把解析结果变成一条可交给 `runChain` 的临时链（不入库，用户想存再另存）。 */
export function plannedToChain(p: PlannedChain): Chain {
  return {
    // 固定前缀：让下游（建议条 / 统计）能一眼认出“这条链是 AI 编的”
    id: "ai-planned",
    name: p.name,
    description: p.description,
    steps: p.steps,
  };
}
