/**
 * useAiSettings 对**外部**配置改动的响应。
 *
 * 修的症状：在「免费额度」弹窗点「一键启用内置免费」，库里已经写成「启用 + 内置免费」、
 * 事件也广播了，可设置页还是挂载时那一份旧 config——「启用 AI 动作」照旧显示关，
 * 用户以为"点了没生效"；更糟的是接着动任何一个开关，都会把这份旧值（enabled:false +
 * 上一家 provider）当成用户配置写回去，把刚启用的又关掉。
 *
 * 同时钉住「自己发的事件要跳过」：persist 是乐观更新（先 setConfig 再落盘），
 * 自写自读会让 reload 跟乐观更新抢，连点开关时界面会闪回旧值。
 *
 * 末尾另有一组判据测试（免密钥 ≠ 本地）：它和上面共用这一整套 mock，
 * 单独开一个文件得把 mock 抄一遍，所以放在一起。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { AiConfig } from "@/lib/api";

const m = vi.hoisted(() => ({
  listen: vi.fn(),
  emit: vi.fn(),
  aiGetConfig: vi.fn(),
  aiSetConfig: vi.fn(),
  aiListProviders: vi.fn(),
  aiHasKey: vi.fn(),
  aiGetUsage: vi.fn(),
  aiGetProviderConfig: vi.fn(),
  aiSetKey: vi.fn(),
  aiTestConnection: vi.fn(),
  aiClearKey: vi.fn(),
  aiDeleteCustomProvider: vi.fn(),
  aiQuotaGet: vi.fn(),
  notifyAiConfigWritten: vi.fn(),
  emitAiConfigChanged: vi.fn(),
  refreshAiAvailability: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: m.listen, emit: m.emit }));
vi.mock("@/lib/api", () => ({
  aiGetConfig: m.aiGetConfig,
  aiSetConfig: m.aiSetConfig,
  aiListProviders: m.aiListProviders,
  aiHasKey: m.aiHasKey,
  aiGetUsage: m.aiGetUsage,
  aiGetProviderConfig: m.aiGetProviderConfig,
  aiSetKey: m.aiSetKey,
  aiTestConnection: m.aiTestConnection,
  aiClearKey: m.aiClearKey,
  aiDeleteCustomProvider: m.aiDeleteCustomProvider,
}));
vi.mock("@/lib/api/quota", () => ({ aiQuotaGet: m.aiQuotaGet }));
vi.mock("@/lib/aiAvailability", () => ({
  notifyAiConfigWritten: m.notifyAiConfigWritten,
  emitAiConfigChanged: m.emitAiConfigChanged,
  refreshAiAvailability: m.refreshAiAvailability,
}));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: m.toast }) }));
vi.mock("@/components/AiOnboarding", () => ({
  aiOnboardingSeen: () => true,
  markAiOnboardingSeen: vi.fn(),
}));

import { useAiSettings } from "@/components/settings/ai/useAiSettings";

type Handler = (e: { payload: { source?: string } | null }) => void;

const OLD: AiConfig = {
  enabled: false,
  provider: "deepseek",
  baseUrl: "",
  model: "",
  dailyBudgetCny: 3,
  timeoutSecs: 60,
  thinkingOff: true,
  protocol: "",
  tagsAsContext: true,
  profileAsContext: true,
};

/** 别处（免费额度弹窗）写完之后库里的样子 */
const NEW: AiConfig = { ...OLD, enabled: true, provider: "builtin-agnes" };

const PROVIDERS = [
  { id: "deepseek", name: "DeepSeek", needsKey: true, baseUrl: "", protocol: "openai", models: [] },
  {
    id: "builtin-agnes",
    name: "内置 Agnes",
    needsKey: false,
    builtinFree: true,
    baseUrl: "https://apihub.agnes-ai.com/v1",
    protocol: "openai",
    models: [],
  },
  {
    id: "ollama",
    name: "Ollama",
    needsKey: false,
    baseUrl: "http://127.0.0.1:11434/v1",
    protocol: "openai",
    models: [],
  },
];

/** 捕获 useAiSettings 注册的那个 ai-config-changed 回调 */
let handler: Handler | null = null;
/** 取消监听是否被调用（卸载时必须调，否则设置页开关几次就叠一堆监听） */
const unlisten = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  handler = null;
  m.listen.mockImplementation((_evt: string, cb: Handler) => {
    handler = cb;
    return Promise.resolve(unlisten);
  });
  m.aiGetConfig.mockResolvedValue(OLD);
  m.aiListProviders.mockResolvedValue(PROVIDERS);
  m.aiHasKey.mockResolvedValue(false);
  m.aiGetUsage.mockResolvedValue(null);
  m.aiQuotaGet.mockRejectedValue(new Error("no quota"));
  m.aiSetConfig.mockResolvedValue(undefined);
  m.notifyAiConfigWritten.mockResolvedValue(undefined);
  m.emitAiConfigChanged.mockResolvedValue(undefined);
  m.refreshAiAvailability.mockResolvedValue(undefined);
});

/** 挂载 + 等首次加载落地 */
async function mount() {
  const r = renderHook(() => useAiSettings());
  await waitFor(() => expect(r.result.current.config.provider).toBe("deepseek"));
  await waitFor(() => expect(handler).not.toBeNull());
  return r;
}

describe("useAiSettings 跟随外部配置改动", () => {
  it("别处改了配置 → 重新读库，开关跟着变（原 bug：一直显示挂载时那份旧值）", async () => {
    const r = await mount();
    expect(r.result.current.config.enabled).toBe(false);

    // 免费额度弹窗写完库并广播（它不带 source）
    m.aiGetConfig.mockResolvedValue(NEW);
    await act(async () => handler?.({ payload: null }));

    expect(r.result.current.config.enabled).toBe(true);
    expect(r.result.current.config.provider).toBe("builtin-agnes");
  });

  it("自己写完发出的那条事件要跳过（否则 reload 会跟乐观更新抢，开关闪回旧值）", async () => {
    const r = await mount();

    await act(async () => r.result.current.saveNow({ enabled: true }));
    const source = m.notifyAiConfigWritten.mock.calls[0][0] as string;
    expect(source).toBeTruthy();

    m.aiGetConfig.mockClear();
    await act(async () => handler?.({ payload: { source } }));
    expect(m.aiGetConfig).not.toHaveBeenCalled();
  });

  it("别人带的 source 不是自己的，照样要 reload", async () => {
    await mount();

    m.aiGetConfig.mockClear();
    await act(async () => handler?.({ payload: { source: "quota-dialog" } }));
    expect(m.aiGetConfig).toHaveBeenCalledTimes(1);
  });

  it("卸载时取消监听", async () => {
    const r = await mount();
    r.unmount();
    await waitFor(() => expect(unlisten).toHaveBeenCalled());
  });

  it("两个实例的 source 互不相同（否则会互相把对方的事件当成自己的丢掉）", async () => {
    const a = await mount();
    await act(async () => a.result.current.saveNow({ enabled: true }));
    const sa = m.notifyAiConfigWritten.mock.calls[0][0] as string;

    m.notifyAiConfigWritten.mockClear();
    const b = await mount();
    await act(async () => b.result.current.saveNow({ enabled: true }));
    const sb = m.notifyAiConfigWritten.mock.calls[0][0] as string;

    expect(sa).not.toBe(sb);
  });
});

/** 挂载在指定服务商上，等首次加载落地 */
async function mountAs(provider: string) {
  m.aiGetConfig.mockResolvedValue({ ...OLD, provider });
  const r = renderHook(() => useAiSettings());
  await waitFor(() => expect(r.result.current.spec?.id).toBe(provider));
  return r;
}

describe("useAiSettings 判据：免密钥 ≠ 本地", () => {
  it("内置免费：算已配置、不按金额计费，但内容会出网", async () => {
    const r = await mountAs("builtin-agnes");
    expect(r.result.current.configured).toBe(true); // 不用填密钥就能用
    expect(r.result.current.isLocal).toBe(true); // token 配额制，不显示 ¥
    expect(r.result.current.contentStaysLocal).toBe(false); // ← 原 bug：这里是 true，于是界面说谎
  });

  it("Ollama：内容确实不出本机", async () => {
    const r = await mountAs("ollama");
    expect(r.result.current.contentStaysLocal).toBe(true);
  });

  it("需要密钥的厂商：既不免密钥也不本地", async () => {
    const r = await mountAs("deepseek");
    expect(r.result.current.isLocal).toBe(false);
    expect(r.result.current.contentStaysLocal).toBe(false);
    expect(r.result.current.configured).toBe(false); // 没存密钥
  });
});
