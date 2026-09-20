/**
 * RcAudioBar 的行为测试（G3-B / G3-C）。
 *
 * 每一条都对着一条**会骗人**的显示：
 * · 对端静音了却不说 → 用户以为链路/声卡坏了；
 * · 没收到对端的 host_audio 帧时照样断言「对方已静音」→ 凭空造状态（旧对端恒不发）；
 * · 「只看」会话摆出「对方外放」按钮 → 点了必被对端拒，就是「点了没反应」；
 * · 按钮态乐观置位 → 对端其实没执行成功也显示已静音。
 */
import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { RcAudioBar } from "@/components/rc/RcAudioBar";
import type { UseRc } from "@/hooks/useRc";
import type { RcStatus } from "@/lib/api/rc";

const mocks = vi.hoisted(() => ({ sendInput: vi.fn(async () => undefined) }));

vi.mock("@/lib/api/rc", () => ({ rcSendInput: mocks.sendInput }));

type PeerAudio = RcStatus["peer_audio"];

function setup(peerAudio: PeerAudio, canControl = true) {
  const onToggleAudio = vi.fn();
  const onStatus = vi.fn();
  const rc = { status: { peer_audio: peerAudio } } as unknown as UseRc;
  render(
    <RcAudioBar
      rc={rc}
      canControl={canControl}
      audioOn
      onToggleAudio={onToggleAudio}
      onStatus={onStatus}
    />,
  );
  return { onToggleAudio, onStatus };
}

beforeEach(() => {
  mocks.sendInput.mockClear();
});

describe("RcAudioBar", () => {
  it("对端按了「不发送声音」时如实说出来", () => {
    setup({ local_mute: true, spk_mute: false });
    expect(screen.getByText("对方已静音")).toBeTruthy();
  });

  it("对端没说静音时不摆断言（旧对端不发这条帧）", () => {
    // null = 从没收到过 host_audio：这时任何「对方静音了」的断言都是凭空造状态
    setup(null);
    expect(screen.queryByText("对方已静音")).toBeNull();
  });

  it("「只看」会话不摆「对方外放」——摆了也必被对端拒", () => {
    setup({ local_mute: false, spk_mute: false }, false);
    expect(screen.queryByText("对方外放")).toBeNull();
  });

  it("可控会话点「对方外放」→ 发 set_host_mute(on=true)", async () => {
    setup({ local_mute: false, spk_mute: false });
    await act(async () => {
      fireEvent.click(screen.getByText("对方外放"));
    });
    expect(mocks.sendInput).toHaveBeenCalledWith({ kind: "set_host_mute", on: true });
  });

  it("对方主机已静音时，按钮是按下态且再点是「恢复」", async () => {
    setup({ local_mute: false, spk_mute: true });
    const btn = screen.getByText("对方外放").closest("button")!;
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(mocks.sendInput).toHaveBeenCalledWith({ kind: "set_host_mute", on: false });
  });

  it("对端执行失败的原因显示出来（它那边没有横幅）", () => {
    setup({ local_mute: false, spk_mute: false, err: "没有默认播放设备" });
    expect(screen.getByText("对方无法切换扬声器")).toBeTruthy();
  });
});
