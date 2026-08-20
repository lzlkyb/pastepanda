/**
 * QuotaDialog「一键启用内置免费」回归测试。
 *
 * 用户实测的症状：点完弹「已切换为内置免费 AI，现在就能用了」，AI 却并没有真的能用。
 * 两个原因，这里各钉一条：
 *
 * 1) 原来只写 provider + enabled，`{...cfg}` 把上一家的 baseUrl/model/protocol 一起带了过去
 *    （比如 deepseek 的地址 + deepseek-chat），拿它们配 Agnes 的内置 key 去请求必然失败——
 *    「点一下就能用」于是成了空话。所以断言的是**落盘的那份 payload**，不是 toast。
 * 2) 写完必须走 notifyAiConfigWritten：判据有 30 秒缓存，不刷新不广播的话
 *    设置页 / 胶囊 / 变换门控看到的还是旧结论。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import type { AiConfig } from "@/lib/api";
import type { QuotaInfo } from "@/lib/api/quota";

const { aiGetConfig, aiGetProviderConfig, aiSetConfig, notifyAiConfigWritten, aiQuotaGet, toast } =
  vi.hoisted(() => ({
    aiGetConfig: vi.fn(),
    aiGetProviderConfig: vi.fn(),
    aiSetConfig: vi.fn(),
    notifyAiConfigWritten: vi.fn(),
    aiQuotaGet: vi.fn(),
    toast: vi.fn(),
  }));

vi.mock("@/lib/api/ai", () => ({ aiGetConfig, aiGetProviderConfig, aiSetConfig }));
vi.mock("@/lib/aiAvailability", () => ({ notifyAiConfigWritten }));
vi.mock("@/lib/api/quota", () => ({
  aiQuotaGet,
  aiQuotaSign: vi.fn(),
  aiQuotaRedeem: vi.fn(),
}));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast }) }));

import { QuotaDialog } from "@/components/QuotaDialog";
import { useDialogStore } from "@/stores/dialogStore";
import { BUILTIN_AGNES_ID } from "@/lib/quota";

/** 上一家：deepseek，地址与模型都填过——正是会被错误带过去的那份值 */
const PREV_CONFIG: AiConfig = {
  enabled: false,
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
  dailyBudgetCny: 3,
  timeoutSecs: 60,
  thinkingOff: true,
  protocol: "openai",
  tagsAsContext: true,
  profileAsContext: true,
};

const QUOTA: QuotaInfo = {
  deviceId: "dev-1",
  granted: 100_000,
  signAdded: 0,
  spent: 0,
  remaining: 100_000,
  signDate: null,
  signStreak: 0,
  canSign: true,
  todaySpent: 0,
  dailyCap: 50_000,
  signCap: 1_000_000,
  redeemedCount: 0,
  weekTotal: 230_000,
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  aiGetConfig.mockResolvedValue(PREV_CONFIG);
  // 内置免费从没手填过地址/模型 → 后端返回空串，由后端回退到 spec 默认
  aiGetProviderConfig.mockResolvedValue({ baseUrl: "", model: "", protocol: "" });
  aiSetConfig.mockResolvedValue(undefined);
  notifyAiConfigWritten.mockResolvedValue(undefined);
  aiQuotaGet.mockResolvedValue(QUOTA);
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  useDialogStore.setState({ quotaOpen: true });
});

/** 冲刷弹窗打开时的两次 async 加载（额度 + 当前服务商） */
const settle = () => act(async () => {});

async function clickEnable() {
  render(<QuotaDialog />);
  await settle();
  const btn = await screen.findByText("一键启用内置免费");
  fireEvent.click(btn);
  await settle();
}

describe("QuotaDialog 一键启用内置免费", () => {
  it("落盘的是内置免费自己的地址与模型，不带上一家的（原 bug：请求打到 deepseek 的地址）", async () => {
    await clickEnable();

    expect(aiGetProviderConfig).toHaveBeenCalledWith(BUILTIN_AGNES_ID);
    expect(aiSetConfig).toHaveBeenCalledTimes(1);
    const saved = aiSetConfig.mock.calls[0][0] as AiConfig;
    expect(saved.provider).toBe(BUILTIN_AGNES_ID);
    expect(saved.enabled).toBe(true);
    // 这三条是本次修复的核心：绝不能还是 deepseek 的
    expect(saved.baseUrl).toBe("");
    expect(saved.model).toBe("");
    expect(saved.protocol).toBe("");
  });

  it("这家手填过地址/模型时用它自己保存的那份", async () => {
    aiGetProviderConfig.mockResolvedValue({
      baseUrl: "https://my-relay.example/v1",
      model: "agnes-2.5-flash",
      protocol: "openai",
    });
    await clickEnable();

    const saved = aiSetConfig.mock.calls[0][0] as AiConfig;
    expect(saved.baseUrl).toBe("https://my-relay.example/v1");
    expect(saved.model).toBe("agnes-2.5-flash");
  });

  it("与本次切换无关的设置原样保留（超时、日预算、标签上下文…）", async () => {
    await clickEnable();

    const saved = aiSetConfig.mock.calls[0][0] as AiConfig;
    expect(saved.timeoutSecs).toBe(60);
    expect(saved.dailyBudgetCny).toBe(3);
    expect(saved.tagsAsContext).toBe(true);
    expect(saved.profileAsContext).toBe(true);
  });

  it("写完必须刷判据 + 广播，否则别处还显示未启用", async () => {
    await clickEnable();
    expect(notifyAiConfigWritten).toHaveBeenCalledTimes(1);
  });

  it("落盘失败要报错，不能报成功（规则 15.3：不静默）", async () => {
    aiSetConfig.mockRejectedValue(new Error("db locked"));
    await clickEnable();

    expect(notifyAiConfigWritten).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("启用失败"), "error");
    expect(toast).not.toHaveBeenCalledWith(expect.stringContaining("现在就能用了"), "success");
  });

  it("当前已经是内置免费时不显示这个按钮（没什么可切的）", async () => {
    aiGetConfig.mockResolvedValue({ ...PREV_CONFIG, provider: BUILTIN_AGNES_ID });
    render(<QuotaDialog />);
    await settle();

    expect(screen.queryByText("一键启用内置免费")).toBeNull();
  });
});
