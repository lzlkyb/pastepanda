/**
 * 「免密钥 ≠ 本地」—— 隐私文案判据的回归测试。
 *
 * 原缺陷：判据写成 `isLocal = !spec.needsKey`，而内置免费（Agnes）的 needsKey 也是 false，
 * 于是设置页与用量卡都对着一个**远程**服务说「内容不出这台电脑」——同一个免费额度弹窗的
 * 标题却写着「内容会发送到该服务商」，两块界面互相打脸，错的偏偏是最该信得过的那一句。
 * 后端 provider.rs 的 is_local() 用白名单、并明确警告过不要从 needsKey 推断，前端得对齐。
 *
 * 计费分支不受影响：Agnes 走 token 配额、确实不按金额计费，所以「显示 token 而不是 ¥」
 * 继续由 isLocal 决定——这也一并钉住，免得下次修隐私文案时顺手把它一起改错。
 */
import { describe, it, expect } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { AiUsage } from "@/lib/api";
import { AiUsageCard } from "@/components/settings/ai/AiUsageCard";

const USAGE: AiUsage = {
  date: "2026-08-20",
  calls: 7,
  billableCalls: 5,
  cachedCalls: 2,
  failedCalls: 0,
  promptTokens: 1200,
  completionTokens: 800,
  costUsd: 0.02,
  costCny: 0.14,
  budgetCny: 3,
  remainingCalls: 90,
};

const LOCAL_ONLY = "内容不出这台电脑";

describe("AiUsageCard 隐私文案", () => {
  it("Ollama：说「内容不出这台电脑」是真的", () => {
    cleanup();
    render(<AiUsageCard usage={USAGE} isLocal contentStaysLocal />);
    expect(screen.getByText(new RegExp(LOCAL_ONLY))).toBeTruthy();
  });

  it("内置免费：免密钥但内容要出网，绝不能说不出这台电脑", () => {
    cleanup();
    render(<AiUsageCard usage={USAGE} isLocal contentStaysLocal={false} />);
    expect(screen.queryByText(new RegExp(LOCAL_ONLY))).toBeNull();
    expect(screen.getByText(/内容会发送到该服务商/)).toBeTruthy();
  });

  it("内置免费仍按 token 展示，不显示金额（它是配额制，不按金额计费）", () => {
    cleanup();
    render(<AiUsageCard usage={USAGE} isLocal contentStaysLocal={false} />);
    expect(screen.getByText(/1200\+800/)).toBeTruthy();
    expect(screen.queryByText(/¥/)).toBeNull();
  });

  it("需要密钥的厂商：走金额分支，也不会出现这句", () => {
    cleanup();
    render(<AiUsageCard usage={USAGE} isLocal={false} contentStaysLocal={false} />);
    expect(screen.queryByText(new RegExp(LOCAL_ONLY))).toBeNull();
    expect(screen.getByText(/已用 ¥0\.14/)).toBeTruthy();
  });
});
