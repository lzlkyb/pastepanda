/**
 * chains/registry.ts — 动作链注册表：预置链 + 自定义链 + 线性链执行器。
 *
 * B1 只做"预置链 + 运行器"；B2 加入自定义链（持久化到 chain_defs 表）与 AI 步骤。
 *
 * 预置链的步骤全部是**纯本地 text 变换**（不依赖 opts.html 的 doc/rich 变换）。
 * 自定义链可以包含 AI 步骤（remote 变换）——运行时每步 AI 会先弹确认（红线：
 * 云端内容不自动发送），确认钩子由运行器传入。
 */

import { getTransform, listTransforms } from "@/lib/transforms/registry";
import { isAiAvailable } from "@/lib/transforms/aiTransforms";
import { chainList } from "@/lib/api/chains";
import type { Transform } from "@/lib/transforms";
import type {
  Chain,
  ChainStepRisk,
} from "./types";

/**
 * 从变换自身属性推导步骤 risk。**这是唯一数据源**（ChainEditor 与 planner 共用）。
 *
 * 为何必须推导而不能“谁造链谁填”：
 *
 * 先说清一个容易误会的点——**risk 不是发送门禁**。{@link runChain} 里拦住
 * “内容出网”的是 `if (t.remote)` + 默认拒绝，step.risk 只被写进 `stages`
 * 做展示。所以填错 risk **不会**让内容静默发出去。
 *
 * 但它仍然必须准确，因为 **ChainRunnerDialog 靠 risk 告诉用户这条链会做什么**
 * （含 AI 步骤的链标错会被显示成“全部本地变换”）。用户就是看着这句话决定
 * 要不要跑的——一个说谎的安全提示比没有提示更坏。只要存在一条“调用方自己
 * 填 risk”的路径，就会漂；而 AI 编链（planner）里这条路径的输入恰恰来自模型。
 *
 * `destructive`（如脱敏）目前只由预置链手写标注，推导不出来，所以不在这里猜。
 */
export function riskOf(t: Transform | undefined): ChainStepRisk {
  return t?.remote ? "network" : "local";
}

export { matchesCondition } from "./conditions";
export { runChain } from "./executor";

/** 官方预置链（B1 四条约稿，全部 text 友好） */
export const PRESET_CHAINS: Chain[] = [
  {
    id: "web-to-text",
    name: "清理网页格式",
    description: "网页转纯文本，保留正文并清理多余空白",
    steps: [
      { transformId: "strip_html", risk: "local" },
      { transformId: "strip_lines", risk: "local" },
      { transformId: "strip", risk: "local" },
    ],
  },
  {
    id: "json-clean",
    name: "整理 JSON",
    description: "校验结构并整理缩进与空格",
    steps: [
      { transformId: "json_format", risk: "local" },
      { transformId: "strip", risk: "local" },
    ],
  },
  {
    id: "mask-and-paste",
    name: "隐藏敏感信息",
    description: "替换识别出的密钥、手机号等，结果需核对",
    steps: [
      { transformId: "mask-sensitive", risk: "destructive" },
      { transformId: "strip", risk: "local" },
    ],
  },
  {
    id: "html-entity-clean",
    name: "HTML 实体解码并清理",
    description: "解码 &amp; 类实体，去掉空行与空白",
    steps: [
      { transformId: "html_decode", risk: "local" },
      { transformId: "strip_lines", risk: "local" },
      { transformId: "strip", risk: "local" },
    ],
  },
  // ===== v6.3 条件链（条件不满足的步骤自动跳过，输出原样传递） =====
  {
    id: "auto-mask",
    name: "发现敏感信息时隐藏",
    description: "含密钥 / 手机号时脱敏，否则原样",
    steps: [
      { transformId: "mask-sensitive", risk: "destructive", condition: { type: "contains-secret" } },
    ],
  },
  {
    id: "json-clean-cond",
    name: "仅整理有效 JSON",
    description: "是 JSON 才格式化，否则原样",
    steps: [
      { transformId: "json_format", risk: "local", condition: { type: "is-json" } },
    ],
  },
  // ===== v6.6 会话级编排（输入 = 工作记忆拼接的连续复制内容） =====
  {
    id: "error-triage",
    name: "整理报错并给修复建议",
    description: "合并报错内容；是代码时继续生成修复建议",
    steps: [
      { transformId: "ai-merge-polish", risk: "network" },
      { transformId: "ai-fix-code", risk: "network", condition: { type: "is-code" } },
    ],
  },
];

/** 同步取预置链（自定义链需异步加载，见 getChainAsync） */
export function getPresetChain(id: string): Chain | undefined {
  return PRESET_CHAINS.find((c) => c.id === id);
}

/** 按 id 取链（先查自定义链，再查预置链；未找到返回 undefined） */
export async function getChainAsync(id: string): Promise<Chain | undefined> {
  const user = await loadUserChains();
  return user.find((c) => c.id === id) ?? PRESET_CHAINS.find((c) => c.id === id);
}

/** 自定义链（懒加载 + 缓存；force 强制刷新） */
let userChainsCache: Chain[] | null = null;
let cacheGeneration = 0;

export async function loadUserChains(force = false, throwOnError = false): Promise<Chain[]> {
  if (!force && userChainsCache) return userChainsCache;
  const generation = cacheGeneration;
  try {
    const defs = await chainList();
    const mapped = defs.map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description,
      steps: d.steps,
      // 后端会在 steps 解析失败时把这两个字段吐出来。不带过来的后果是：
      // 损坏的链在界面上和“用户存了一条空链”长得一模一样，而后端为了区分这两者
      // 特意加的字段就白加了。
      corrupted: d.stepsCorrupted,
      rawSteps: d.stepsRaw,
    }));
    if (generation === cacheGeneration) userChainsCache = mapped;
    return mapped;
  } catch (error) {
    if (throwOnError) throw error;
    userChainsCache = userChainsCache ?? [];
  }
  return userChainsCache;
}

/** 失效缓存（保存/删除链后调用） */
export function invalidateUserChains(): void {
  cacheGeneration++;
  userChainsCache = null;
}

/**
 * 同步读已缓存的自定义链。**只读缓存，不触发加载。**
 *
 * 给同步路径（主动建议）用：缓存没热就只看预置链，不为了“顺便给个建议”
 * 去起一次异步加载——建议本身是附带能力，不该引入等待。
 */
export function cachedUserChains(): Chain[] {
  return (userChainsCache ?? []).filter(isChainAvailable);
}

/** 全部链：用户自定义在前，预置在后 */
export async function listAllChains(): Promise<Chain[]> {
  const user = await loadUserChains();
  return [...user, ...PRESET_CHAINS].filter(isChainAvailable);
}

/** AI 可用性与副作用过滤共用一处，编辑器与 AI 计划清单不能各自漂移。 */
export function chainStepTransforms(): Transform[] {
  return listTransforms().filter(t => t.kind !== "action" && (!t.remote || isAiAvailable()));
}

export function chainHasAiSteps(chain: Chain): boolean {
  return chain.steps.some(step => {
    const transform = getTransform(step.transformId);
    return transform ? !!transform.remote : step.risk === "network" || step.transformId.startsWith("ai-");
  });
}

export function isChainAvailable(chain: Chain): boolean {
  return isAiAvailable() || !chainHasAiSteps(chain);
}
