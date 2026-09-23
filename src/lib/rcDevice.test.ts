import { describe, it, expect } from "vitest";
import {
  deviceAvatarStyle,
  relTime,
  DEFAULT_RC_DEVICE_NAME,
  RC_NOTE_MAX,
  truncateRcNote,
  normalizeRcNote,
  canReconnectTo,
  lastRcTarget,
  rcDisplayName,
} from "@/lib/rcDevice";

describe("deviceAvatarStyle (D1/C10)", () => {
  it("任意不同 node_id 得到同一颜色（一屏一强调色，不再随机）", () => {
    const a = deviceAvatarStyle("node-A");
    const b = deviceAvatarStyle("node-B");
    const c = deviceAvatarStyle("completely-different-id");
    expect(a.background).toBe(b.background);
    expect(b.background).toBe(c.background);
    expect(a.color).toBe(b.color);
  });

  it("背景/文字都不含随机 hsl(", () => {
    const s = deviceAvatarStyle("any-id");
    expect(s.background).not.toContain("hsl(");
    expect(s.color).not.toContain("hsl(");
  });

  it("基于语义 token 派生、文字为深色（对比度达标不变量）", () => {
    const s = deviceAvatarStyle("any-id");
    expect(s.background).toContain("color-mix");
    expect(s.background).toContain("var(--accent");
    expect(s.color).toContain("var(--text-primary");
  });
});

describe("relTime (D4)", () => {
  const NOW = 1_700_000_000_000;

  it("null / undefined / 0 → 空串（调用方据此不显示空文案）", () => {
    expect(relTime(null, NOW)).toBe("");
    expect(relTime(undefined, NOW)).toBe("");
    expect(relTime(0, NOW)).toBe("");
  });

  it("未来时间 → 刚刚（边界不崩）", () => {
    expect(relTime(NOW + 10_000, NOW)).toBe("刚刚");
  });

  it("刚发生（<60s）→ 刚刚", () => {
    expect(relTime(NOW - 30_000, NOW)).toBe("刚刚");
  });

  it("分钟级", () => {
    expect(relTime(NOW - 5 * 60_000, NOW)).toBe("5 分钟前");
  });

  it("小时级", () => {
    expect(relTime(NOW - 2 * 3_600_000, NOW)).toBe("2 小时前");
  });

  it("天级", () => {
    expect(relTime(NOW - 3 * 86_400_000, NOW)).toBe("3 天前");
  });

  it("默认 now 取 Date.now() 不抛错", () => {
    expect(typeof relTime(Date.now() - 1000)).toBe("string");
  });
});

describe("DEFAULT_RC_DEVICE_NAME (C4)", () => {
  it("非空常量，供两处统一来源", () => {
    expect(DEFAULT_RC_DEVICE_NAME.length).toBeGreaterThan(0);
  });
});

describe("备注名归一化（A1：字符数口径，不是字节也不是 UTF-16 单元）", () => {
  it("与后端 NOTE_MAX_CHARS 同值", () => {
    expect(RC_NOTE_MAX).toBe(60);
  });

  it("🔴 60 个汉字原样留下（按字节判会以为有 180 字节而整条拒收）", () => {
    const cn = "汉".repeat(60);
    expect(cn.length).toBe(60); // UTF-16 单元 = 60
    expect(new TextEncoder().encode(cn).length).toBe(180); // 字节 = 180
    expect(normalizeRcNote(cn)).toBe(cn);
  });

  it("超上限按字符截断，且不劈开代理对", () => {
    const emoji = normalizeRcNote("🖥".repeat(80));
    expect(Array.from(emoji).length).toBe(60);
    expect(emoji).toBe("🖥".repeat(60));
    expect(Array.from(normalizeRcNote("汉".repeat(61))).length).toBe(60);
  });

  it("trim + 纯空白等价于清除备注", () => {
    expect(normalizeRcNote("  客厅 电脑  ")).toBe("客厅 电脑");
    expect(normalizeRcNote("   ")).toBe("");
    expect(normalizeRcNote("")).toBe("");
  });

  it("truncateRcNote 不 trim：输入过程中要能打出前导空格", () => {
    // 输入框用 truncateRcNote（不是 normalizeRcNote）——边打边 trim 会让用户
    // 永远打不出「 客厅」这种以空格开头的备注。
    expect(truncateRcNote("  客厅")).toBe("  客厅");
  });
});

describe("canReconnectTo（A5：历史「再次连接」的摆与不摆）", () => {
  const T = [{ node_id: "peerA" }, { node_id: "peerB" }];

  it("设备还在 + 通道在跑 → 可再次连接", () => {
    expect(canReconnectTo(T, "peerA", true)).toBe(true);
  });

  it("🔴 通道没跑 / 设备已被忘记 → 都不摆（点了必得 channel_down / not_paired）", () => {
    expect(canReconnectTo(T, "peerA", false)).toBe(false);
    expect(canReconnectTo(T, "peer-gone", true)).toBe(false);
    expect(canReconnectTo([], "peerA", true)).toBe(false);
  });
});

describe("lastRcTarget（B1：托盘「连接 <上次设备>」的目标）", () => {
  it("取列表第一台 rc 设备（后端已按 last_seen 降序）", () => {
    const t = lastRcTarget([
      { node_id: "b", source: "rc" },
      { node_id: "a", source: "rc" },
    ]);
    expect(t?.node_id).toBe("b");
  });

  it("🔴 跳过纯同步配对设备：它们在工作台里都要先「去配对」", () => {
    expect(lastRcTarget([{ node_id: "s", source: "sync" }])).toBeNull();
    expect(
      lastRcTarget([
        { node_id: "s", source: "sync" },
        { node_id: "r", source: "rc" },
      ])?.node_id,
    ).toBe("r");
  });

  it("空列表 → null（托盘那一项整块不出现）", () => {
    expect(lastRcTarget([])).toBeNull();
  });
});

describe("rcDisplayName（方案 B：统一显示名的唯一取值口）", () => {
  it("后端给了 display_name → 原样用（备注已由后端判定优先）", () => {
    expect(
      rcDisplayName({ display_name: "工作电脑", note: "", name: "DESKTOP-A" }),
    ).toBe("工作电脑");
  });

  it("旧版后端没给 display_name → 回落 note，再回落 name", () => {
    expect(rcDisplayName({ note: "客厅", name: "DESKTOP-A" })).toBe("客厅");
    expect(rcDisplayName({ note: "", name: "DESKTOP-A" })).toBe("DESKTOP-A");
  });

  it("历史条目只有 peer_name（快照字段名）→ 同层回落", () => {
    expect(rcDisplayName({ peer_name: "DESKTOP-A" })).toBe("DESKTOP-A");
    expect(rcDisplayName({ display_name: "工作电脑", peer_name: "DESKTOP-A" })).toBe(
      "工作电脑",
    );
  });

  it("🔴 空白不算有名字：display_name/note 全空白时不能用「  」占位", () => {
    expect(rcDisplayName({ display_name: "  ", note: "", name: "DESKTOP-A" })).toBe(
      "DESKTOP-A",
    );
    expect(rcDisplayName({ note: "   ", name: "DESKTOP-A" })).toBe("DESKTOP-A");
  });

  it("全部为空 → 用 fallback；没给 fallback → 空串（调用方整段不渲染）", () => {
    expect(rcDisplayName({}, "fp-1234")).toBe("fp-1234");
    expect(rcDisplayName({ display_name: "", note: "", name: "" }, "fp")).toBe("fp");
    expect(rcDisplayName({})).toBe("");
  });

  it("null / undefined 字段按缺失处理（旧载荷 / 快照字段可能缺）", () => {
    expect(rcDisplayName({ display_name: null, note: undefined, name: "N" })).toBe("N");
    expect(rcDisplayName({ display_name: null, note: undefined, name: null }, "fb")).toBe("fb");
  });
});
