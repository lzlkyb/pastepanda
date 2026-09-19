import { describe, expect, it } from "vitest";
import { parseUnoInput, unoCodeShapeOk } from "@/lib/rcUno";

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
