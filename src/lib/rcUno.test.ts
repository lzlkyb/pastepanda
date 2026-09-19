import { describe, expect, it } from "vitest";
import {
  UNO_PASS_MAX_CHARS,
  UNO_PASS_MIN_CHARS,
  nodeIdShapeOk,
  parseUnoInput,
  unoCodeShapeOk,
  unoPassCharsOk,
} from "@/lib/rcUno";

describe("parseUnoInput", () => {
  it("完整接入串：拆出码与设备号", () => {
    expect(parseUnoInput("PPU-7K2M-9PQX-kbaiiimcgytfa5ttc")).toEqual({
      code: "7K2M9PQX",
      nodeId: "kbaiiimcgytfa5ttc",
    });
  });

  it("完整接入串宽容：前缀小写、无横杠、前后杂质都能容", () => {
    expect(parseUnoInput("接入码：ppu 7k2m 9pqx kbaiiimcgytfa5ttc 请尽快")).toEqual({
      code: "7K2M9PQX",
      nodeId: "kbaiiimcgytfa5ttc",
    });
  });

  it("裸码：8 位，横杠可有可无，统一大写", () => {
    expect(parseUnoInput("7K2M-9PQX")).toEqual({ code: "7K2M9PQX" });
    expect(parseUnoInput("7k2m9pqx")).toEqual({ code: "7K2M9PQX" });
    expect(parseUnoInput("7K2M 9PQX")).toEqual({ code: "7K2M9PQX" });
  });

  it("带引导词的裸码也能抠出来", () => {
    expect(parseUnoInput("接入码：7K2M-9PQX")).toEqual({ code: "7K2M9PQX" });
  });

  it("认不出就返回 null——发起端要给明确的错误提示", () => {
    expect(parseUnoInput("")).toBeNull();
    expect(parseUnoInput("   ")).toBeNull();
    expect(parseUnoInput("随便一句话")).toBeNull();
    expect(parseUnoInput("7K2M-9PQ")).toBeNull();
    // 只有设备号没有码也不是接入串
    expect(parseUnoInput("kbaiiimcgytfa5ttc")).toBeNull();
  });

  it("🔴 设备号不能被大写化——node_id 大小写敏感", () => {
    // base32 小写的 node_id 混大写字母时必须原样保留
    const r = parseUnoInput("PPU-7K2M-9PQX-KbaIiimcgytfa5ttc");
    expect(r?.nodeId).toBe("KbaIiimcgytfa5ttc");
    expect(r?.code).toBe("7K2M9PQX");
  });
});

describe("unoCodeShapeOk", () => {
  it("形状检查：长度与字符集（易混字符映射后）", () => {
    expect(unoCodeShapeOk("7K2M9PQX")).toBe(true);
    expect(unoCodeShapeOk("7k2m9pqx")).toBe(true);
    // O 映射成 0 后合法
    expect(unoCodeShapeOk("7K2O9PQX")).toBe(true);
    // U 不在去歧义字符集
    expect(unoCodeShapeOk("7K2U9PQX")).toBe(false);
    // 长度不够
    expect(unoCodeShapeOk("7K2M9PQ")).toBe(false);
  });
});

describe("nodeIdShapeOk（方案 C：固定密码发起要填对端设备号）", () => {
  // 真实 iroh node_id 是 52 位 base32 小写
  const nid = "kbaiiimcgytfa5ttcjjm3jclpvkq4t2oefpijbfzs3tfpm5wwwwa".slice(0, 52);
  it("52 位接受，长短都拒", () => {
    expect(nodeIdShapeOk(nid)).toBe(true);
    // 两端空白宽容
    expect(nodeIdShapeOk(" " + nid + " ")).toBe(true);
    expect(nodeIdShapeOk(nid.slice(0, 51))).toBe(false);
    expect(nodeIdShapeOk(nid + "a")).toBe(false);
    expect(nodeIdShapeOk("")).toBe(false);
  });
  it("带分隔符或非 base32 字符拒——引导用户去设置页复制而不是猜", () => {
    expect(nodeIdShapeOk(nid.slice(0, 26) + "-" + nid.slice(26))).toBe(false);
    // base32 里没有 0/1/8/9 之外的超集问题——这里只拦明显杂质
    expect(nodeIdShapeOk(nid.slice(0, 51) + "!")).toBe(false);
  });
  it("UNO_PASS_MIN_CHARS 与后端口径一致（unop::PASS_MIN_CHARS = 6）", () => {
    expect(UNO_PASS_MIN_CHARS).toBe(6);
  });
});

describe("unoPassCharsOk（方案 C：密码长度按字符数，不按 UTF-16 单元）", () => {
  it("🔴 emoji 按字符数：3 个 emoji 是 3 个字符（String.length 会谎报成 6）", () => {
    // "😀😀😀".length === 6（UTF-16 单元），但字符数是 3 → 不够 6，必须拒
    expect("😀😀😀".length).toBe(6);
    expect(unoPassCharsOk("😀😀😀")).toBe(false);
    // 6 个 emoji = 6 个字符 → 过（.length 是 12）
    expect(unoPassCharsOk("😀😀😀😀😀😀")).toBe(true);
  });
  it("下限与上限（含两端空白剥除）", () => {
    expect(unoPassCharsOk("abc12")).toBe(false);
    expect(unoPassCharsOk(" abc123 ")).toBe(true);
    expect(unoPassCharsOk("a".repeat(64))).toBe(true);
    expect(unoPassCharsOk("a".repeat(65))).toBe(false);
    expect(unoPassCharsOk("      ")).toBe(false);
    expect(UNO_PASS_MAX_CHARS).toBe(64);
  });
});
