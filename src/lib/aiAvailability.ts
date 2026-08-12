/**
 * lib/aiAvailability.ts —— 「AI 到底能不能用」的**唯一判定 + 唯一缓存**。
 *
 * 为什么要单独一个模块：同一件事以前算了两遍——
 * aiTransforms 的 aiAvailable 标志查了密钥（对的），useAiStatus 只看 enabled+provider
 * 没查密钥（错的）。于是「已启用但没配密钥」在 TopBar 上显示成绿色「AI 就绪」，
 * 而每个 AI 动作点下去都必然失败（最容易走到这一步的是切换服务商：密钥按厂商分文件存，
 * 切到没存过密钥的厂商，enabled 仍是 true）。
 *
 * 现在判定只写在 {@link computeAiAvailability} 一处，缓存也只有本模块这一份：
 * 变换门控（isAiAvailable）与主窗口感知（useAiStatus / TopBar 胶囊 / 快捷区门控）
 * 都只是它的读者，不允许任何地方再自己拼一遍条件。
 */
import { aiGetConfig, aiGetUsageStats, aiHasKey, aiListProviders } from "@/lib/api/ai";
import { logger } from "@/lib/logger";

/**
 * 三态 + 一个加载态：
 * - `loading` 还没问过后端 —— 什么都别断言（UI 应占位，不要先说「未开启」）；
 * - `off`     总开关关着（或没选服务商）；
 * - `nokey`   开关开着但**配不全**（缺密钥）—— AI 动作会失败，绝不能显示成「就绪」；
 * - `on`      真的能用。
 */
export type AiAvailability = "loading" | "off" | "nokey" | "on";

export interface AiAvailabilityState {
  status: AiAvailability;
  /** 最近 7 天调用次数，只有 on 态有意义（纯展示） */
  weekCalls: number;
  /** 当前模型名（off 态为空）；配了服务商但没填模型时给「已配置」占位 */
  model: string;
}

/** 缓存 TTL：防止多个订阅者/频繁 render 把后端问穿 */
const TTL_MS = 30_000;

const OFF: AiAvailabilityState = { status: "off", weekCalls: 0, model: "" };

/**
 * 判定本体——全仓库只有这一处算「AI 能不能用」。
 *
 * 注意顺序：先判 enabled，再判密钥，最后才拉用量。
 */
export async function computeAiAvailability(): Promise<AiAvailabilityState> {
  const [cfg, hasKey, providers] = await Promise.all([
    aiGetConfig(),
    aiHasKey(),
    aiListProviders(),
  ]);
  if (!cfg.enabled || !cfg.provider.trim()) return { ...OFF };

  // Ollama 这类本地厂商 needsKey=false：一律要求 hasKey 会把配好的本地模型误判成不可用
  const spec = providers.find((p) => p.id === cfg.provider);
  const keyOk = spec && !spec.needsKey ? true : hasKey;
  const model = cfg.model.trim() || "已配置";
  if (!keyOk) return { status: "nokey", weekCalls: 0, model };

  let weekCalls = 0;
  try {
    // 用量只在真能用时才拉：off/nokey 下这次 IPC 是白花的。
    // 且用量失败只是少个展示数字，不能反过来把「可用」判成「不可用」。
    weekCalls = (await aiGetUsageStats(7))?.totalCalls ?? 0;
  } catch (e) {
    logger.warn("获取 AI 用量失败（不影响可用性判定）", e);
  }
  return { status: "on", weekCalls, model };
}

let state: AiAvailabilityState = { status: "loading", weekCalls: 0, model: "" };
let loadedAt = 0;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** 同步读当前判定结果。detect() 之类同步场景只能读缓存，所以缓存必须是共用的这一份 */
export function getAiAvailability(): AiAvailabilityState {
  return state;
}

/** 订阅变化（React 侧由 useAiStatus 包装）。返回取消订阅 */
export function subscribeAiAvailability(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function commit(next: AiAvailabilityState) {
  const changed =
    next.status !== state.status || next.weekCalls !== state.weekCalls || next.model !== state.model;
  state = next;
  if (changed) listeners.forEach((l) => l());
}

async function load(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      commit(await computeAiAvailability());
      loadedAt = Date.now();
    } catch (e) {
      logger.warn("判定 AI 可用性失败", e);
      // 首次失败必须落地成 off（不能永远停在 loading 转圈）；
      // 已有结论时保留旧值——一次 IPC 抖动不该把「可用」翻成「不可用」。
      if (state.status === "loading") commit({ ...OFF });
      loadedAt = Date.now(); // 失败也记时间，避免每次挂载都重试打后端
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** 惰性加载：未加载或超 TTL 才问后端；并发只问一次 */
export function ensureAiAvailabilityLoaded(): void {
  if (state.status !== "loading" && Date.now() - loadedAt < TTL_MS) return;
  void load().catch(() => {});
}

/** 审查：事件监听模块级注册一次 —— 此前 useAiStatus 每个订阅者各注册一个
 *  listen("ai-config-changed")（App + 胶囊双监听重复刷新）。 */
let eventListenerInstalled = false;

export function ensureAiConfigListener(): void {
  if (eventListenerInstalled) return;
  eventListenerInstalled = true;
  import("@tauri-apps/api/event")
    .then(({ listen }) => listen("ai-config-changed", () => void refreshAiAvailability()))
    .catch(() => {});
}

/**
 * 强制重新判定。设置面板改完配置/密钥后必须调，否则动作与胶囊都不会即时变。
 * 若已有请求在飞，先等它落地再重来——避免拿到「写配置之前」的结果。
 */
export async function refreshAiAvailability(): Promise<void> {
  loadedAt = 0;
  if (inflight) await inflight.catch(() => {});
  return load();
}

/** 仅供测试与初始化：直接写死状态，不碰后端 */
export function setAiAvailabilityForTest(status: AiAvailability, patch?: Partial<AiAvailabilityState>): void {
  commit({ status, weekCalls: 0, model: status === "off" || status === "loading" ? "" : "已配置", ...patch });
  loadedAt = Date.now();
}
