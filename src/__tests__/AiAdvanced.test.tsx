/**
 * AiAdvanced 回归测试：钉死「每次 render 都落盘」的配置振荡 bug。
 *
 * 原缺陷：那个「折叠前落盘」的 effect 依赖写成了 `[p]`（整个 props 对象）。
 * AiTab 传进来的 props 含 inline 箭头（onToggle / onClearKey），每次 render 都是新对象，
 * 于是 effect 每次 render 都跑一遍 cleanup → onCommit()，而 cleanup 捕获的是**上一轮**的
 * onCommit（闭包里是上一轮的 config）。结果：改任何一个开关都会被上一轮旧值写回去，
 * 新旧值逐帧互相覆盖 —— 界面鬼畜、每帧几次 IPC、配置最终停在哪个值全看被打断在哪一帧；
 * 面板刚打开、config 还是 DEFAULT_CONFIG 的那一帧更是直接把「未启用 + deepseek」写进库。
 *
 * 所以这里测的是**次数与时机**，不是渲染结果：
 * 光 render 绝不能落盘；只有「展开 → 收起」和「展开着卸载」才落盘，且用的必须是最新草稿。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import type { AiConfig } from "@/lib/api";

const toast = vi.fn();
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/lib/api/semantic", () => ({
  semanticStatus: vi.fn(async () => ({
    enabled: false,
    model: "",
    defaultModel: "text-embedding-3-small",
    vectorCount: 0,
    pending: 0,
    provider: "deepseek",
    providerSupports: true,
  })),
  semanticIndex: vi.fn(async () => ({ indexed: 0, pendingLeft: 0 })),
  semanticSetConfig: vi.fn(async () => {}),
}));

import { AiAdvanced } from "@/components/settings/ai/AiAdvanced";

const CONFIG: AiConfig = {
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

/** 复刻 AiTab 的调用方式：inline 箭头保证 props 对象每次都是新引用 */
function view(open: boolean, onCommit: () => void, config: AiConfig = CONFIG) {
  return (
    <AiAdvanced
      open={open}
      onToggle={() => {}}
      config={config}
      spec={null}
      hasKey={false}
      onDraft={() => {}}
      onCommit={onCommit}
      onSave={() => {}}
      onClearKey={() => {}}
    />
  );
}

/** 冲刷 loadSem 那次 async setState，免得 act 警告盖住真正的断言 */
const settle = () => act(async () => {});

beforeEach(() => {
  toast.mockClear();
});

describe("AiAdvanced 草稿落盘时机", () => {
  it("反复 render 不落盘（原 bug：每次 render 都落一次，导致配置逐帧振荡）", async () => {
    const onCommit = vi.fn();
    const { rerender } = render(view(true, onCommit));
    await settle();
    expect(onCommit).not.toHaveBeenCalled();

    for (let i = 0; i < 5 ; i++) rerender(view(true, onCommit));
    await settle();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("config 变化引起的 render 也不落盘（振荡就是从这里自激的）", async () => {
    const onCommit = vi.fn();
    const { rerender } = render(view(true, onCommit));
    await settle();

    rerender(view(true, onCommit, { ...CONFIG, enabled: true }));
    rerender(view(true, onCommit, { ...CONFIG, enabled: false }));
    await settle();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("展开 → 收起：落盘一次", async () => {
    const onCommit = vi.fn();
    const { rerender } = render(view(true, onCommit));
    await settle();

    rerender(view(false, onCommit));
    await settle();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("展开着卸载：落盘一次（关设置面板时草稿不丢）", async () => {
    const onCommit = vi.fn();
    const { unmount } = render(view(true, onCommit));
    await settle();

    unmount();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("收起状态下卸载：不落盘（没展开过就没有草稿可存）", async () => {
    const onCommit = vi.fn();
    const { unmount } = render(view(false, onCommit));
    await settle();

    unmount();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("落盘用的是最新的 onCommit，不是上一轮的过期闭包", async () => {
    const stale = vi.fn();
    const fresh = vi.fn();
    const { rerender } = render(view(true, stale));
    await settle();

    // onCommit 每次 config 变都是新引用（useAiSettings 里它依赖 config），
    // 换成 fresh 后收起——落盘必须走 fresh，走 stale 就意味着又在写旧 config。
    rerender(view(true, fresh));
    rerender(view(false, fresh));
    await settle();
    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledTimes(1);
  });
});
