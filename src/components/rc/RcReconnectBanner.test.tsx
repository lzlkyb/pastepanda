/**
 * RcReconnectBanner 守卫单测（乙-⑤，2026-09-29，待拍板⑤）。
 *
 * 钉两件事：
 * 1. **只讲结果，不报过程**：`attempt/max` 仍在 props 里，但界面上不许出现
 *    「第 N/M 次」「(1/3)」这类计数——对标 §6.6 六家都把自动重连当默认体验，
 *    给用户数失败次数只会把一次抖动说成一场事故。
 * 2. 用尽那一支要说清下一步：可能是对方不在线，**也可能是免确认被关掉**
 *    （那时重新发起就需要对方同意），并留下「重新发起」这颗出口。
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RcReconnectBanner } from "./RcReconnectBanner";
import type { RcStatus } from "@/lib/api/rc";

type Reconnecting = NonNullable<RcStatus["reconnecting"]>;

const ep = (over: Partial<Reconnecting> = {}): Reconnecting =>
  ({
    peer: "node-abcd",
    peer_name: "工作电脑",
    display_name: "",
    capability: "control",
    attempt: 2,
    max: 3,
    gave_up: false,
    ...over,
  }) as Reconnecting;

describe("RcReconnectBanner（乙-⑤ 只讲结果）", () => {
  it("在途：说「正在尝试恢复」，且整个 DOM 里找不到重试计数", () => {
    const { container } = render(
      <RcReconnectBanner reconnecting={ep()} busy={false} onRetry={vi.fn()} />,
    );
    expect(screen.getByText(/正在尝试恢复/)).toBeTruthy();
    expect(screen.getByText(/重连无需对方确认/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/2\/3|第.{0,3}次/);
  });

  it("用尽：换成「没能自动恢复」+ 需要对方同意那句，并给出「重新发起」出口", () => {
    const onRetry = vi.fn().mockResolvedValue(true);
    render(<RcReconnectBanner reconnecting={ep({ attempt: 3, gave_up: true })} busy={false} onRetry={onRetry} />);
    expect(screen.getByText(/没能自动恢复/)).toBeTruthy();
    expect(screen.getByText(/关闭这台设备的免确认/)).toBeTruthy();
    expect(screen.getByText(/需要对方同意/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重新发起" }));
    expect(onRetry).toHaveBeenCalledWith("node-abcd", "control");
  });

  it("在途时不摆「重新发起」（自动重试还在跑，多一颗键只会让人抢着点）", () => {
    render(<RcReconnectBanner reconnecting={ep()} busy={false} onRetry={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "重新发起" })).toBeNull();
  });
});
