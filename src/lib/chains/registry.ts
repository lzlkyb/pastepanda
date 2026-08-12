/**
 * chains/registry.ts — 动作链注册表：预置链 + 自定义链 + 线性链执行器。
 *
 * B1 只做"预置链 + 运行器"；B2 加入自定义链（持久化到 chain_defs 表）与 AI 步骤。
 *
 * 预置链的步骤全部是**纯本地 text 变换**（不依赖 opts.html 的 doc/rich 变换）。
 * 自定义链可以包含 AI 步骤（remote 变换）——运行时每步 AI 会先弹确认（红线：
 * 云端内容不自动发送），确认钩子由运行器传入。
 */

import { getTransform } from "@/lib/transforms/registry";
import { chainList } from "@/lib/api/chains";
import type { Transform } from "@/lib/transforms";
import { maskSensitiveText } from "@/lib/mask";
import type {
  Chain,
  ChainRunResult,
  ChainRunStage,
  ChainStepCondition,
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

/**
 * 步骤执行条件判定（v6.3，纯本地规则零 LLM）：
 * - `always`（缺省）：无条件，恒执行；
 * - `is-json`：内容可被 JSON.parse（对象或数组）；
 * - `contains-secret`：内容里识别出密钥/手机号/邮箱/身份证/IP；
 * - `is-code`：内容像代码（函数/类/关键字/分号等结构化特征）。
 */
export function matchesCondition(
  cond: ChainStepCondition | undefined,
  text: string,
): boolean {
  if (!cond || cond.type === "always") return true;
  const t = (text || "").trim();
  switch (cond.type) {
    case "is-json": {
      try {
        JSON.parse(t);
        return true;
      } catch {
        return false;
      }
    }
    case "contains-secret":
      return maskSensitiveText(t).count > 0;
    case "is-code":
      return (
        t.length > 20 &&
        /(function\s|class\s|import\s|const\s|let\s|=>|\{[\s\S]*\}|;)/.test(t)
      );
    default:
      return true;
  }
}

/** 官方预置链（B1 四条约稿，全部 text 友好） */
export const PRESET_CHAINS: Chain[] = [
  {
    id: "web-to-text",
    name: "网页 → 纯文本",
    description: "剥离 HTML 标签、清掉空行与首尾空白",
    steps: [
      { transformId: "strip_html", risk: "local" },
      { transformId: "strip_lines", risk: "local" },
      { transformId: "strip", risk: "local" },
    ],
  },
  {
    id: "json-clean",
    name: "JSON 清洗并格式化",
    description: "校验并缩进美化 JSON",
    steps: [
      { transformId: "json_format", risk: "local" },
      { transformId: "strip", risk: "local" },
    ],
  },
  {
    id: "mask-and-paste",
    name: "敏感信息脱敏",
    description: "遮罩密钥 / 手机号 / 邮箱等敏感内容",
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
    name: "敏感自动脱敏",
    description: "含密钥 / 手机号时脱敏，否则原样",
    steps: [
      { transformId: "mask-sensitive", risk: "destructive", condition: { type: "contains-secret" } },
    ],
  },
  {
    id: "json-clean-cond",
    name: "JSON 条件格式化",
    description: "是 JSON 才格式化，否则原样",
    steps: [
      { transformId: "json_format", risk: "local", condition: { type: "is-json" } },
    ],
  },
  // ===== v6.6 会话级编排（输入 = 工作记忆拼接的连续复制内容） =====
  {
    id: "error-triage",
    name: "排错流水线",
    description: "合并连续复制的报错 → 修复（会话编排）",
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

export async function loadUserChains(force = false): Promise<Chain[]> {
  if (!force && userChainsCache) return userChainsCache;
  try {
    const defs = await chainList();
    userChainsCache = defs.map((d) => ({
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
  } catch {
    userChainsCache = userChainsCache ?? [];
  }
  return userChainsCache;
}

/** 失效缓存（保存/删除链后调用） */
export function invalidateUserChains(): void {
  userChainsCache = null;
}

/**
 * 同步读已缓存的自定义链。**只读缓存，不触发加载。**
 *
 * 给同步路径（主动建议）用：缓存没热就只看预置链，不为了“顺便给个建议”
 * 去起一次异步加载——建议本身是附带能力，不该引入等待。
 */
export function cachedUserChains(): Chain[] {
  return userChainsCache ?? [];
}

/** 全部链：用户自定义在前，预置在后 */
export async function listAllChains(): Promise<Chain[]> {
  const user = await loadUserChains();
  return [...user, ...PRESET_CHAINS];
}

/**
 * 线性执行一条链：上一步输出 → 下一步输入。
 *
 * 规则（对齐 X1 规划）：
 * - 失败**立即停止**并返回，明确到步骤（failedAt + 该步 error）；
 * - 失败时 final = 最后一个成功步骤的输出（原始内容不丢）；
 * - 步骤不存在（未注册）也按失败处理，不会静默跳过；
 * - **AI 步骤（remote 变换）执行前调用 `onAiConfirm`**：返回 false 则中止——
 *   云端内容不自动发送（红线），中止也算失败定位（error 说明原因）。
 */
export function runChain(
  chain: Chain,
  input: string,
  opts: Record<string, unknown> = {},
  onAiConfirm?: (step: { transformId: string; label: string }, index: number) => Promise<boolean>,
): Promise<ChainRunResult> {
  return (async () => {
    const stages: ChainRunStage[] = [];
    let current = input;

    // **0 步的链必须算失败**。之前这里没有守卫，for 循环直接不执行 → 返回
    // `{ ok: true, stages: [], final: input }`，即“什么都没做却报告成功”——
    // 用户以为链跑过了，实际内容一个字没变。静默成功比失败更难排查。
    //
    // 两种来源的文案必须分开：`corrupted` 是后端解析 `steps` 失败退成的空数组
    // （用户原本配过步骤，数据丢了）；普通空链是用户本来就没配。
    if (chain.steps.length === 0) {
      stages.push({
        stepIndex: 0,
        transformId: "",
        label: chain.name,
        risk: "local",
        input: current,
        output: "",
        ok: false,
        error: chain.corrupted
          ? "这条链的步骤配置已损坏（后端无法解析），请重新配置后再跑"
          : "这条链没有任何步骤，无从执行",
        durationMs: 0,
      });
      return { ok: false, stages, final: current, failedAt: 0 };
    }

    for (let i = 0; i < chain.steps.length; i++) {
      const step = chain.steps[i];
      const t = getTransform(step.transformId);
      const label = step.label ?? t?.label ?? step.transformId;

      if (!t) {
        stages.push({
          stepIndex: i, transformId: step.transformId, label, risk: step.risk,
          input: current, output: "", ok: false, error: "变换不存在（未注册）", durationMs: 0,
        });
        return { ok: false, stages, final: current, failedAt: i };
      }

      // v6.3 条件执行：条件不满足 → 跳过（输出=输入，原样传递）。
      // 放在 AI 确认之前：跳过的步骤不会执行，也就无需联网确认。
      if (step.condition && !matchesCondition(step.condition, current)) {
        stages.push({
          stepIndex: i, transformId: t.id, label, risk: step.risk,
          input: current, output: current, ok: true, durationMs: 0, skipped: true,
        });
        continue;
      }

      // AI 步骤：先确认再发送（红线：云端内容不自动执行）。
      //
      // **没传回调 = 视为未确认**，而不是跳过检查。之前写的是
      // `t.remote && onAiConfirm`，安全检查靠调用方自觉传参；而路线图还要加
      // 卡片动作条 / 托盘等入口，任何一处忘了传，剪贴板内容就会在用户没
      // 确认的情况下发到云端。默认拒绝才是把红线从“自觉”变成“强制”。
      if (t.remote) {
        const confirmed = onAiConfirm
          ? await onAiConfirm({ transformId: t.id, label }, i)
          : false;
        if (!confirmed) {
          stages.push({
            stepIndex: i, transformId: t.id, label, risk: step.risk,
            input: current, output: "", ok: false,
            error: "已取消：这一步会把内容发送到云端，需要你确认", durationMs: 0,
          });
          return { ok: false, stages, final: current, failedAt: i };
        }
      }

      const started = performance.now();
      const r = await t.run(current, opts);
      const durationMs = Math.round(performance.now() - started);

      if (r.ok && r.output !== undefined) {
        stages.push({
          stepIndex: i, transformId: t.id, label, risk: step.risk,
          input: current, output: r.output, ok: true, durationMs,
        });
        current = r.output;
      } else {
        stages.push({
          stepIndex: i, transformId: t.id, label, risk: step.risk,
          input: current, output: "", ok: false, error: r.message ?? "变换失败", durationMs,
        });
        return { ok: false, stages, final: current, failedAt: i };
      }
    }

    return { ok: true, stages, final: current };
  })();
}
