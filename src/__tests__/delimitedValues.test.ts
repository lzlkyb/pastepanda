import { describe, it, expect } from "vitest";
import { parseDelimitedValues } from "@/lib/transforms/detectors";
import { analyzeContent } from "@/lib/transforms/analyzer";
import { getTransform, applicableTransforms } from "@/lib/transforms/registry";
// 触发内置变换注册
import "@/lib/transforms";

/**
 * 用户实际遇到的格式：方括号包裹 + 逗号分隔 + 带前导零的 24 位业务 ID。
 * 修复前首尾两个值会带上方括号，生成的 SQL 语法合法却永远查不中这两条。
 */
const REAL_INPUT =
  "[076300754046516800301326, 008403113229928402770220, 008403113273178402783367, 076300754043786800286370, 008403113312468402514165, 008403113229928402484788, 076300754043786800283592, 008403113226338402766385]";

describe("parseDelimitedValues — 外层括号剥除", () => {
  it("剥掉外层方括号，首尾值不再被污染（本次修复的核心）", () => {
    const info = parseDelimitedValues(REAL_INPUT);
    expect(info.ok).toBe(true);
    expect(info.count).toBe(8);
    expect(info.delimiter).toBe(",");
    // 首值不带 [，尾值不带 ]
    expect(info.values[0]).toBe("076300754046516800301326");
    expect(info.values[7]).toBe("008403113226338402766385");
    // 前导零与全 24 位精度原样保留
    expect(info.values.every((v) => v.length === 24)).toBe(true);
    expect(info.values.some((v) => v.includes("[") || v.includes("]"))).toBe(false);
  });

  it("同样剥圆括号与花括号", () => {
    expect(parseDelimitedValues("(a, b, c)").values).toEqual(["a", "b", "c"]);
    expect(parseDelimitedValues("{a, b, c}").values).toEqual(["a", "b", "c"]);
  });

  it("括号不成对时不剥（不能把函数调用等文本误剥）", () => {
    // 首字符非括号 → 不剥，func( 会成为第一个值的一部分
    const info = parseDelimitedValues("func(a, b, c)");
    expect(info.ok).toBe(true);
    expect(info.values[0]).toBe("func(a");
  });

  it("无外层括号的裸列表不受影响", () => {
    expect(parseDelimitedValues("1001,1002,1003").values).toEqual(["1001", "1002", "1003"]);
  });

  it("分号 / 竖线 / 中文逗号仍然支持，且同样剥括号", () => {
    expect(parseDelimitedValues("[a;b;c]").values).toEqual(["a", "b", "c"]);
    expect(parseDelimitedValues("[a|b|c]").values).toEqual(["a", "b", "c"]);
    expect(parseDelimitedValues("[a，b，c]").values).toEqual(["a", "b", "c"]);
  });

  it("只剥一层，不递归", () => {
    expect(parseDelimitedValues("[[a, b, c]]").values[0]).toBe("[a");
  });

  it("剥后为空或不足 3 个值 → 不命中", () => {
    expect(parseDelimitedValues("[]").ok).toBe(false);
    expect(parseDelimitedValues("[a, b]").ok).toBe(false);
    expect(parseDelimitedValues("").ok).toBe(false);
  });

  it("仍然拒绝被逗号分割的中文句子", () => {
    const info = parseDelimitedValues(
      "这是一句很长的中文描述文字，这是又一句很长的中文描述文字，还有第三句很长的中文描述文字",
    );
    expect(info.ok).toBe(false);
  });

  it("超过 3 行 → 交给 column-to-sql-in，不归本函数", () => {
    expect(parseDelimitedValues("a,b,c\nd,e,f\ng,h,i\nj,k,l").ok).toBe(false);
  });
});

describe("analyzer 预计算路径与兼底路径一致", () => {
  it("features.delimited 也已剥括号（两套机制已合为一）", () => {
    const features = analyzeContent(REAL_INPUT, "text");
    expect(features.delimited?.ok).toBe(true);
    expect(features.delimited?.count).toBe(8);
    expect(features.delimited?.values[0]).toBe("076300754046516800301326");
    expect(features.delimited?.values[7]).toBe("008403113226338402766385");
  });

  it("预计算结果与直接解析逐字相等", () => {
    const viaAnalyzer = analyzeContent(REAL_INPUT, "text").delimited;
    const viaDirect = parseDelimitedValues(REAL_INPUT);
    expect(viaAnalyzer?.values).toEqual(viaDirect.values);
    expect(viaAnalyzer?.count).toBe(viaDirect.count);
  });
});

describe("delimited-to-sql-in 输出", () => {
  it("命中且进入推荐区（score ≥ 0.6）", () => {
    const scored = applicableTransforms({ text: REAL_INPUT, contentType: "text" });
    const hit = scored.find((s) => s.transform.id === "delimited-to-sql-in");
    expect(hit).toBeDefined();
    expect(hit!.score).toBeGreaterThanOrEqual(0.6);
  });

  it("输出不再含方括号，且保留全 24 位精度", async () => {
    const r = await getTransform("delimited-to-sql-in")!.run(REAL_INPUT);
    expect(r.ok).toBe(true);
    expect(r.meta?.count).toBe(8);
    // 修复前为 IN ('[076300754046516800301326', … '008403113226338402766385]')
    expect(r.output).toContain("IN ('076300754046516800301326'");
    expect(r.output).toContain("'008403113226338402766385')");
    expect(r.output).not.toContain("'[");
    expect(r.output).not.toContain("]'");
    // 绝不能出现科学计数法（走 JSON.parse 的话 24 位会变 7.6e+22）
    expect(r.output).not.toContain("e+");
  });

  it("引号与包裹选项仍生效", async () => {
    const t = getTransform("delimited-to-sql-in")!;
    expect((await t.run("[a,b,c]", { quote: "double" })).output).toBe('IN ("a", "b", "c")');
    expect((await t.run("[a,b,c]", { wrap: "paren" })).output).toBe("('a', 'b', 'c')");
    expect((await t.run("[a,b,c]", { wrap: "values" })).output).toBe("'a', 'b', 'c'");
  });
});
