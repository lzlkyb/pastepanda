/**
 * 设备可达性文案（多档，与后端 RcPresence 同构）+ A2 侧栏分组（2026-09-21 批4）。
 */
import { describe, it, expect } from "vitest";
import {
  deviceGroupOf,
  deviceRowSubLabel,
  groupRcTargets,
  osLabel,
  presenceMainLabel,
  presenceHint,
  presenceDotClass,
} from "@/lib/rcDevice";

describe("presenceMainLabel", () => {
  it("live → 在线", () => {
    expect(presenceMainLabel("live", "刚刚")).toBe("在线");
  });
  it("recent → 带相对时间的「还在」", () => {
    expect(presenceMainLabel("recent", "1 分钟前")).toBe("1 分钟前还在");
    expect(presenceMainLabel("recent", "")).toBe("刚刚还在");
  });
  it("seen → 「见过」", () => {
    expect(presenceMainLabel("seen", "3 天前")).toBe("3 天前见过");
  });
  it("never → 明确说还没连上", () => {
    expect(presenceMainLabel("never", "")).toBe("配对后还没连上过");
  });
});

describe("presenceHint / dot", () => {
  it("live 是绿点 + 局域网可达", () => {
    expect(presenceDotClass("live")).toBe("dotOn");
    expect(presenceHint("live")).toContain("局域网");
  });
  it("recent 琥珀 + 仍可尝试", () => {
    expect(presenceDotClass("recent")).toBe("dotRecent");
    expect(presenceHint("recent")).toBe("仍可尝试");
  });
  it("seen/never 灰点", () => {
    expect(presenceDotClass("seen")).toBe("dotOff");
    expect(presenceDotClass("never")).toBe("dotOff");
    expect(presenceHint("seen")).toContain("中继");
    expect(presenceHint("never")).toContain("指纹");
  });
});

describe("deviceGroupOf（四档可达性 → 三组）", () => {
  it("seen 与 recent 同组，never 独立成组", () => {
    expect(deviceGroupOf("live")).toBe("live");
    expect(deviceGroupOf("recent")).toBe("recent");
    expect(deviceGroupOf("seen")).toBe("recent");
    /* never = 配对后从没连上过，塞进「最近使用」等于把「还没用过」说成「用过」 */
    expect(deviceGroupOf("never")).toBe("never");
  });
});

describe("groupRcTargets", () => {
  const t = (id: string, presence: string) => ({ id, presence });

  it("按 在线 → 最近使用 → 尚未连接 排组，组内保持输入顺序", () => {
    const groups = groupRcTargets([
      t("a", "seen"),
      t("b", "live"),
      t("c", "never"),
      t("d", "live"),
      t("e", "recent"),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["live", "recent", "never"]);
    expect(groups[0].label).toBe("在线");
    expect(groups[0].items.map((i) => i.id)).toEqual(["b", "d"]);
    expect(groups[1].label).toBe("最近使用");
    expect(groups[1].items.map((i) => i.id)).toEqual(["a", "e"]);
    expect(groups[2].label).toBe("尚未连接");
    expect(groups[2].items.map((i) => i.id)).toEqual(["c"]);
  });

  it("空组不产出——不摆一个写着「在线 0」的空标题", () => {
    expect(groupRcTargets([t("a", "never")]).map((g) => g.key)).toEqual(["never"]);
  });

  it("总数守恒：各组求和 === 输入长度，未知 presence 按 seen 归入「最近使用」也不丢", () => {
    const input = [t("a", "live"), t("b", "???"), t("c", "never"), t("d", "")];
    const groups = groupRcTargets(input);
    expect(groups.reduce((n, g) => n + g.items.length, 0)).toBe(input.length);
    expect(groups.find((g) => g.key === "recent")?.items.map((i) => i.id)).toEqual(["b", "d"]);
  });

  it("空输入 → 空数组（侧栏交给空态渲染）", () => {
    expect(groupRcTargets([])).toEqual([]);
  });
});

describe("deviceRowSubLabel（A2 侧栏第二行）", () => {
  it("在线行给实测路径——状态已由分组标题承担，不重复", () => {
    expect(deviceRowSubLabel("live", "刚刚", "局域网直连")).toBe("局域网直连");
  });
  it("在线但还没连过 → 回落「在线」，不编路径", () => {
    expect(deviceRowSubLabel("live", "刚刚", "")).toBe("在线");
  });
  it("离线行给上次时间——路径是上次的、可能早已失效，不进这一行", () => {
    expect(deviceRowSubLabel("recent", "1 分钟前", "绕中继")).toBe("1 分钟前还在");
    expect(deviceRowSubLabel("seen", "3 天前", "绕中继")).toBe("3 天前见过");
    expect(deviceRowSubLabel("never", "", "")).toBe("配对后还没连上过");
  });
});

describe("osLabel（设备详情「在线 · Windows 11 · …」中间那段）", () => {
  it("正常值原样返回", () => {
    expect(osLabel("Windows 11")).toBe("Windows 11");
    expect(osLabel("macOS")).toBe("macOS");
  });
  it("两端空白去掉", () => {
    expect(osLabel("  Windows 11 ")).toBe("Windows 11");
  });
  it("空串 / 纯空白 / 缺失一律归成空串——调用方据空串整段不渲染", () => {
    // 还没建立过会话、或对端是旧版 / 采不到：都不许编一个「未知系统」摆出去
    expect(osLabel("")).toBe("");
    expect(osLabel("   ")).toBe("");
    expect(osLabel(undefined)).toBe("");
    expect(osLabel(null)).toBe("");
  });
  it("是假值时调用方能安全地用 `&&` 门控渲染", () => {
    expect(Boolean(osLabel(""))).toBe(false);
    expect(Boolean(osLabel("Windows 11"))).toBe(true);
  });
});
