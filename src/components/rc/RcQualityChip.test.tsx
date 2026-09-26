/**
 * RcQualityChip 守卫（2026-09-26 对齐稿）：读数分档、无样本不渲染、
 * 点击经 rcDetailPanel 单例桥开合 RcHud 面板（芯片与 ⓘ 同一个面板）。
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RcQualityChip } from "./RcQualityChip";
import { RcHud } from "./RcHud";
import { resetRttTrend } from "@/lib/rcRttTrend";
import styles from "./RemoteComputer.module.css";

afterEach(() => resetRttTrend());

describe("RcQualityChip", () => {
  it("无样本（rtt 未测到）整枚不渲染", () => {
    const { container } = render(<RcQualityChip rttMs={0} fps={0} />);
    expect(container.firstChild).toBeNull();
  });

  it("good 绿档读数带帧率", () => {
    const { container } = render(<RcQualityChip rttMs={28} fps={60} />);
    const chip = container.firstElementChild!;
    expect(chip.className).toContain(styles.qualityChipOk);
    expect(chip.textContent).toBe("28ms · 60fps");
  });

  it("poor 换红档边框类", () => {
    const { container } = render(<RcQualityChip rttMs={200} fps={15} />);
    expect(container.firstElementChild!.className).toContain(styles.qualityChipBad);
  });

  it("点击芯片 = 开合 RcHud 的同一个连接详情面板", () => {
    render(<RcHud {...HUD_MIN} rttMs={42} />);
    render(<RcQualityChip rttMs={42} fps={30} />);
    expect(screen.queryByText("连接详情")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "连接质量读数，点击展开连接详情" }));
    expect(screen.getByText("往返延迟 · 近 60s")).not.toBeNull();
  });
});

const HUD_MIN = {
  codec: "jpeg",
  fps: 0,
  rttMs: 0,
  quality: "auto",
  scope: "virtual",
  linkState: "connected" as const,
  pathKind: "",
};
