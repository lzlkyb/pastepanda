import { afterEach, describe, expect, it } from "vitest";
import { applicableTransforms, getTransform, registerTransform, unregisterTransform } from "@/lib/transforms";
import { recommendScored, __resetRecommendForTest } from "@/lib/recommend";
import { setAiAvailable } from "@/lib/transforms/aiTransforms";

const prose = "现在连接有个问题，如果IP地址变化了，会弹出通知给用户复制变动IP的指令，但是这个通知，有时候被手动关闭了，用户就没有地方去复制了，如果用户在终端页面使用ssh访问远端的AI的时候，连接页面的IP变动了需要切换到连接页面去复制，这是不友好的地方，给我方案";
const score = (id: string, text: string) => getTransform(id)!.detect({ text, contentType: "text" });
afterEach(() => { unregisterTransform("ai-relevance-test"); setAiAvailable(false); __resetRecommendForTest(); });

describe("recommend intent rather than delimiter count", () => {
  it.each([prose, "如果连接变了，会弹出通知，但是不会关闭", "please reconnect, then restart, let me know"])("prose is not a SQL IN recommendation: %s", text => {
    expect(score("delimited-to-sql-in", text)).toBe(0);
  });
  it("more commas cannot increase certainty", () => {
    expect(score("delimited-to-sql-in", "001,002,003,004,005,006,007,008,009,010")).toBe(score("delimited-to-sql-in", "001,002,003"));
  });
  it("Chinese names remain available without claiming strong query intent", () => {
    const match = score("delimited-to-sql-in", "北京，上海，广州");
    expect(match).toBeGreaterThan(0);
    expect(match).toBeLessThan(0.6);
  });
  it.each(["00124,00125,00126", "A001,A002,A003"])("structured IDs still match: %s", text => {
    expect(score("delimited-to-sql-in", text)).toBeGreaterThanOrEqual(0.6);
  });
  it("column SQL uses the same sentence guard", () => {
    expect(score("column-to-sql-in", "如果连接变了\n会弹出通知\n但是不会关闭")).toBe(0);
  });
  it("manual conversion still preserves Chinese names and leading zeros", () => {
    const t = getTransform("delimited-to-sql-in")!;
    expect(t.run("北京，上海，广州")).toMatchObject({ ok: true, output: "IN ('北京', '上海', '广州')" });
    expect(t.run("00124,00125,00126")).toMatchObject({ ok: true, output: "IN ('00124', '00125', '00126')" });
  });
});

describe("strict codec applicability", () => {
  it.each(["abcdefghijklmnoq", "ordinaryenglishwords"])("ASCII letters alone are insufficient for Base64: %s", text => {
    expect(score("base64_decode", text)).toBe(0);
  });
  it("invalid UTF-8 percent escapes are not a decode recommendation", () => {
    expect(score("url_decode", "%FF%FE")).toBe(0);
  });
  it("JWT needs JSON header and payload, not just three ASCII parts", () => {
    expect(score("jwt_decode", "abcdefgh.abcdefgh.abcdefgh")).toBe(0);
  });
  it.each(["SGVsbG8sIFBhc3RlUGFuZGEh", "5L2g5aW9"])("readable Base64 still matches: %s", text => {
    expect(score("base64_decode", text)).toBeGreaterThanOrEqual(0.6);
  });
});

it("low confidence does not silently manufacture AI confidence", () => {
  setAiAvailable(true);
  registerTransform({ id: "ai-relevance-test", label: "test", group: "ai", remote: true,
    detect: () => 0.4, run: async () => ({ ok: true, output: "" }) });
  const match = recommendScored({ text: "An ordinary sentence, with no specified operation.", contentType: "text" }).find(x => x.transform.id === "ai-relevance-test");
  expect(match?.score).toBe(0.4);
});

it("recommendation includes verifiable content evidence", () => {
  const match = applicableTransforms({ text: "00124,00125,00126", contentType: "text" }).find(x => x.transform.id === "delimited-to-sql-in");
  expect(match?.reason?.text).toMatch(/3.*(?:ID|标识符|数据值)/);
});
