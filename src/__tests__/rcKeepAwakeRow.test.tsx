/**
 * 「会话防休眠」那一行的行为契约（2026-10-04）。
 *
 * 为什么单独一个文件而不是塞进 `rcSettingsGroups.test.tsx`（那个已经 349 行）：
 * 这一行的失败方式全是静默的——默认值被人改成 true 就等于替用户按住了屏幕与电源计划；
 * 通道关了开关还能按 = 界面说「已开」而锁根本不会拿；判据错吃到 `config.rc_enabled`
 * 则在切换在飞的那段窗口里显示成「能改但改了不生效」。三条都要红得下来。
 *
 * 跨端接线（命令名 / 投影 / 取锁点）由 Rust 侧 `守卫_会话防休眠六处接线成对` 钉，
 * 这里只管渲染出来的这一层。
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RcCapGroup } from "@/components/settings/rcGroups/RcCapGroup";
import type { RcStatus } from "@/lib/api/rc";
import type { RcLocalAbility } from "@/hooks/useRcLocalAbility";
import type { UseRc } from "@/hooks/useRc";

const status = (over: Partial<RcStatus> = {}) =>
  ({
    enabled: true,
    running: true,
    capability: "control",
    quality: "auto",
    capture_scope: "virtual",
    device_deny: {},
    joins: [],
    uno: [],
    ...over,
  }) as unknown as RcStatus;

const ability = {
  loadError: null,
  reload: vi.fn(),
  capsUnknown: false,
  monitorsUnknown: false,
  qualities: [],
  monitors: null,
  caps: null,
} as unknown as RcLocalAbility;

function renderRow(over: Partial<RcStatus> = {}, rcOver: Record<string, unknown> = {}) {
  const setKeepAwake = vi.fn().mockResolvedValue(true);
  const rc = {
    busy: false,
    setKeepAwake,
    setCapability: vi.fn(),
    setQuality: vi.fn(),
    setCaptureScope: vi.fn(),
    ...rcOver,
  } as unknown as UseRc;
  render(
    <RcCapGroup
      rc={rc}
      status={status(over)}
      ability={ability}
      open
      onToggle={() => {}}
    />,
  );
  return { setKeepAwake };
}

/** 本仓没装 jest-dom，开关态按既有写法直接读属性。 */
const sw = () => screen.getByRole("switch") as HTMLButtonElement;

describe("会话防休眠行", () => {
  it("开关态取后端真值 status.keep_awake，不读 config", () => {
    renderRow({ keep_awake: true });
    expect(sw().getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("开")).toBeTruthy();
  });

  it("默认（后端没这个字段）= 关，不许把「未知」渲染成开", () => {
    renderRow({});
    expect(sw().getAttribute("aria-checked")).toBe("false");
  });

  it("点一下发的是取反值，且只发一次", () => {
    const { setKeepAwake } = renderRow({ keep_awake: false });
    fireEvent.click(sw());
    expect(setKeepAwake).toHaveBeenCalledTimes(1);
    expect(setKeepAwake).toHaveBeenCalledWith(true);
  });

  it("通道没开 ⇒ 禁用并说明原因（组内其余行的同款判据 = status.enabled）", () => {
    renderRow({ enabled: false });
    expect(sw().disabled).toBe(true);
    expect(sw().title).toBe("远程协助已关闭");
  });

  it("切换在飞（rc.busy）⇒ 禁用，且不拿「通道已关闭」当理由糊弄", () => {
    renderRow({}, { busy: true });
    expect(sw().disabled).toBe(true);
    // 通道明明开着，禁用理由却是「远程协助已关闭」就是假话——与组内其余行同款判据
    expect(sw().title).not.toBe("远程协助已关闭");
  });
});
