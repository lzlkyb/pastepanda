import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUALITY,
  RC_QUALITIES,
  qualityHudLabel,
  qualityLabel,
  visibleQualities,
} from "@/lib/rcQuality";

describe("qualityLabel（短文案）", () => {
  it("十一档的中文名", () => {
    expect(qualityLabel("auto")).toBe("自动");
    expect(qualityLabel("smooth")).toBe("流畅");
    expect(qualityLabel("balanced")).toBe("均衡");
    expect(qualityLabel("sharp")).toBe("清晰");
    expect(qualityLabel("ultra")).toBe("超清");
    expect(qualityLabel("uhd")).toBe("原生");
    expect(qualityLabel("fps60")).toBe("高帧率");
    expect(qualityLabel("fps120")).toBe("高帧率+");
    expect(qualityLabel("fps144")).toBe("高帧率·144");
    expect(qualityLabel("fps165")).toBe("高帧率·165");
  });

  it("未知 / 空串回落默认档文案，不显示空字符串", () => {
    expect(qualityLabel("nonsense")).toBe(qualityLabel(DEFAULT_QUALITY));
    expect(qualityLabel("")).toBe(qualityLabel(DEFAULT_QUALITY));
  });
});

describe("RC_QUALITIES（画质档唯一真源）", () => {
  it("🔴 唯一真源：短文案必须取自同一张表，不允许出现第二套 label", () => {
    // 收口之前 `RcAllowPanel` 写「超清（约 2.5K）」、画质条写「超清」，
    // 设置页与画质条对同一个档给出不同按钮文字。这条钉子钉住「只有一张表」。
    for (const o of RC_QUALITIES) {
      expect(qualityLabel(o.key)).toBe(o.label);
      expect(o.label.length).toBeGreaterThan(0);
      expect(o.tip.length).toBeGreaterThan(0);
    }
  });

  it("十一档且顺序固定为 自动 → 流畅 → 均衡 → 清晰 → 超清 → 原生 → 4K60 → 高帧率 → 高帧率+ → 144 → 165（界面按这个顺序排）", () => {
    // uhd60（4K60，Q3/Q4）插在「原生」之后：HEVC 硬编专属档，仅在能力达标时
    // 由 visibleQualities 放出；fps60/fps120/fps144/fps165（高帧率系）再排其后
    expect(RC_QUALITIES.map((o) => o.key)).toEqual([
      "auto",
      "smooth",
      "balanced",
      "sharp",
      "ultra",
      "uhd",
      "uhd60",
      "fps60",
      "fps120",
      "fps144",
      "fps165",
    ]);
  });

  it("key 不重复", () => {
    expect(new Set(RC_QUALITIES.map((o) => o.key)).size).toBe(RC_QUALITIES.length);
  });

  it("默认档是「自动」（2A：与后端缺省档一致）", () => {
    expect(DEFAULT_QUALITY).toBe("auto");
  });

  it("说明性文字留在 tip 里（fps / 宽度），不挤进按钮文案", () => {
    const ultra = RC_QUALITIES.find((o) => o.key === "ultra")!;
    // 「约 2.5K」这类原本只在设置页出现的信息不能丢，它现在是共享 tip 的一部分
    expect(ultra.tip).toContain("2.5K");
    expect(ultra.label).toBe("超清");
  });

  it("🔴 每档都有 meta：菜单的「双列信息卡」全靠它把档位差异摆到明面", () => {
    // 缺 meta 的那一档在双列网格里会短一截，用户又只能回到「逐项悬停 tip」的老路
    for (const o of RC_QUALITIES) expect(o.meta?.trim().length ?? 0).toBeGreaterThan(0);
  });

  it("🔴 solo 只给「模式」项（当前只有 auto）：它是唯一跨列独占一行的项", () => {
    expect(RC_QUALITIES.filter((o) => o.solo).map((o) => o.key)).toEqual(["auto"]);
  });
});

describe("visibleQualities（P1：跑不到的档不卖）", () => {
  it("能力不达标时高帧率系/uhd60 都不出现在可选列表，其余档齐全", () => {
    const q = visibleQualities({});
    expect(q.map((o) => o.key)).not.toContain("fps120");
    expect(q.map((o) => o.key)).not.toContain("fps144");
    expect(q.map((o) => o.key)).not.toContain("fps165");
    expect(q.map((o) => o.key)).not.toContain("uhd60");
    expect(q.map((o) => o.key)).toContain("fps60");
    expect(q.length).toBe(RC_QUALITIES.length - 4);
  });

  it("Q3/Q4：uhd60 只在 HEVC 可用时出现（发起端看对端 caps / 设置页看本机探测）", () => {
    expect(visibleQualities({ peerHevc: true }).map((o) => o.key)).toContain("uhd60");
    expect(visibleQualities({ peerHevc: false }).map((o) => o.key)).not.toContain("uhd60");
    // 设置页视角：本机 h264 硬编 + HEVC 硬编都在才出
    expect(visibleQualities({ h264Gpu: true, hevcHw: true }).map((o) => o.key)).toContain("uhd60");
    expect(visibleQualities({ h264Gpu: true, hevcHw: false }).map((o) => o.key)).not.toContain(
      "uhd60",
    );
    expect(visibleQualities({ peerHevc: true }).map((o) => o.key)).not.toContain("fps120");
  });

  it("发起端视角：对端 caps 报了 fps120 才显示（fps120 兼容旧口径：不带 hz 也放行）", () => {
    expect(visibleQualities({ peerFps120: true }).map((o) => o.key)).toContain("fps120");
    expect(visibleQualities({ peerFps120: false }).map((o) => o.key)).not.toContain("fps120");
  });

  it("2026-09-22：fps144/fps165 必须有刷新率证据——按对端/本机屏刷新率分档", () => {
    // 对端报了能力但没报刷新率（旧对端/异常）：只出 fps120，144/165 宁缺毋滥
    const noHz = visibleQualities({ peerFps120: true });
    expect(noHz.map((o) => o.key)).not.toContain("fps144");
    expect(noHz.map((o) => o.key)).not.toContain("fps165");
    // 120Hz 屏：fps120 有、144/165 无
    const hz120 = visibleQualities({ peerFps120: true, refreshHz: 120 }).map((o) => o.key);
    expect(hz120).toContain("fps120");
    expect(hz120).not.toContain("fps144");
    // 150Hz 屏：+144 仍无 165
    const hz150 = visibleQualities({ peerFps120: true, refreshHz: 150 }).map((o) => o.key);
    expect(hz150).toContain("fps144");
    expect(hz150).not.toContain("fps165");
    // 170Hz 屏：全出
    const hz170 = visibleQualities({ peerFps120: true, refreshHz: 170 }).map((o) => o.key);
    expect(hz170).toContain("fps144");
    expect(hz170).toContain("fps165");
    // 设置页视角：本机探测同口径
    expect(visibleQualities({ h264Gpu: true, refreshHz: 144 }).map((o) => o.key)).toContain(
      "fps144",
    );
    expect(visibleQualities({ h264Gpu: true, refreshHz: 100 }).map((o) => o.key)).not.toContain(
      "fps144",
    );
  });

  it("本机视角：硬件 D3D11-aware MFT + 刷新 ≥100Hz 才显示", () => {
    expect(visibleQualities({ h264Gpu: true, refreshHz: 120 }).map((o) => o.key)).toContain(
      "fps120",
    );
    expect(visibleQualities({ h264Gpu: true, refreshHz: 60 }).map((o) => o.key)).not.toContain(
      "fps120",
    );
    expect(visibleQualities({ h264Gpu: false, refreshHz: 144 }).map((o) => o.key)).not.toContain(
      "fps120",
    );
  });
});

describe("qualityHudLabel（HUD 文案：自动档的两种形态）", () => {
  it("实名档只显示档名，不带任何前缀", () => {
    expect(qualityHudLabel("sharp", "sharp")).toBe("清晰");
    expect(qualityHudLabel("ultra", undefined)).toBe("超清");
  });

  it("auto + 已知生效档（被控端视角）= 自动 · 生效档", () => {
    expect(qualityHudLabel("auto", "sharp")).toBe("自动 · 清晰");
    expect(qualityHudLabel("auto", "smooth")).toBe("自动 · 流畅");
  });

  it("🔴 出站会话（档位由对方生效）说清「由对方决定」，不拿本机档冒充对端档", () => {
    expect(qualityHudLabel("auto", undefined, true)).toBe("自动 · 由对方决定");
  });

  it("🔴 不再出现「自动 · 自动」这种空话", () => {
    // 旧实现把本机 cfg 解析出的 "auto" 当「生效档」传进来，HUD 显示成「自动 · 自动」。
    // auto 的落点只有推流那台机器知道，不知道就只说「自动」。
    expect(qualityHudLabel("auto", "auto")).toBe("自动");
    expect(qualityHudLabel("auto", "auto", true)).toBe("自动 · 由对方决定");
    expect(qualityHudLabel("auto")).toBe("自动");
  });
});
