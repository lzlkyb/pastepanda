import { describe, it, expect } from "vitest";
import {
  parseJsonArray, pickDefaultField, pluckField, toSqlIn, sqlInFromJson,
} from "@/lib/jsonToolbox";

describe("parseJsonArray", () => {
  it("parses a string array", () => {
    const info = parseJsonArray('["a", "b", "c"]');
    expect(info.ok).toBe(true);
    expect(info.count).toBe(3);
    expect(info.elemType).toBe("string");
    expect(info.values).toEqual(["a", "b", "c"]);
  });

  it("parses a number array", () => {
    const info = parseJsonArray("[1, 2, 3]");
    expect(info.ok).toBe(true);
    expect(info.elemType).toBe("number");
  });

  it("parses an object array and collects field union in order", () => {
    const info = parseJsonArray('[{"id":1,"name":"a"},{"id":2,"age":3}]');
    expect(info.ok).toBe(true);
    expect(info.elemType).toBe("object");
    expect(info.fields).toEqual(["id", "name", "age"]);
  });

  it("detects mixed types", () => {
    expect(parseJsonArray('[1, "a"]').elemType).toBe("mixed");
  });

  it("ignores nulls when detecting dominant type", () => {
    const info = parseJsonArray("[1, null, 2]");
    expect(info.elemType).toBe("number");
  });

  it("fails on invalid JSON", () => {
    const info = parseJsonArray("{not json");
    expect(info.ok).toBe(false);
    expect(info.reason).toBe("invalid-json");
  });

  it("fails on non-array JSON", () => {
    const info = parseJsonArray('{"id": 1}');
    expect(info.ok).toBe(false);
    expect(info.reason).toBe("not-array");
  });

  it("fails on empty array", () => {
    const info = parseJsonArray("[]");
    expect(info.ok).toBe(false);
    expect(info.reason).toBe("empty");
  });
});

describe("pickDefaultField", () => {
  it("prefers exact id", () => {
    expect(pickDefaultField(["name", "id", "age"])).toBe("id");
  });

  it("prefers *Id suffix", () => {
    expect(pickDefaultField(["userName", "userId", "status"])).toBe("userId");
  });

  it("prefers *_id suffix", () => {
    expect(pickDefaultField(["order_id", "amount"])).toBe("order_id");
  });

  it("falls back to first field", () => {
    expect(pickDefaultField(["name", "age"])).toBe("name");
  });

  it("returns null for empty fields", () => {
    expect(pickDefaultField([])).toBeNull();
  });
});

describe("pluckField", () => {
  it("extracts field values from objects", () => {
    expect(pluckField([{ id: 1 }, { id: 2 }], "id")).toEqual([1, 2]);
  });

  it("keeps non-object items as-is", () => {
    expect(pluckField([{ id: 1 }, 5] as unknown[], "id")).toEqual([1, 5]);
  });

  it("returns undefined for missing field", () => {
    expect(pluckField([{ name: "a" }], "id")).toEqual([undefined]);
  });
});

describe("toSqlIn", () => {
  it("quotes strings with single quotes by default", () => {
    expect(toSqlIn(["a", "b"])).toBe("IN ('a', 'b')");
  });

  it("does not quote numbers", () => {
    expect(toSqlIn([1, 2, 3])).toBe("IN (1, 2, 3)");
  });

  it("escapes embedded single quotes by doubling", () => {
    expect(toSqlIn(["O'Brien"])).toBe("IN ('O''Brien')");
  });

  it("can disable escaping", () => {
    expect(toSqlIn(["O'Brien"], { escape: false })).toBe("IN ('O'Brien')");
  });

  it("supports double quote style", () => {
    expect(toSqlIn(["a"], { quote: "double" })).toBe('IN ("a")');
  });

  it("supports backtick quote style", () => {
    expect(toSqlIn(["a"], { quote: "backtick" })).toBe("IN (`a`)");
  });

  it("supports paren-only wrap", () => {
    expect(toSqlIn([1, 2], { wrap: "paren" })).toBe("(1, 2)");
  });

  it("supports values-only wrap", () => {
    expect(toSqlIn([1, 2], { wrap: "values" })).toBe("1, 2");
  });

  it("renders null as NULL by default", () => {
    expect(toSqlIn([1, null])).toBe("IN (1, NULL)");
  });

  it("skips null when nullAs=skip", () => {
    expect(toSqlIn([1, null, 2], { nullAs: "skip" })).toBe("IN (1, 2)");
  });

  it("dedupes when requested", () => {
    expect(toSqlIn(["a", "a", "b"], { dedupe: true })).toBe("IN ('a', 'b')");
  });

  it("maps booleans to 1/0", () => {
    expect(toSqlIn([true, false])).toBe("IN (1, 0)");
  });

  it("skips nested objects/arrays", () => {
    expect(toSqlIn([1, { a: 1 }, [2], 3])).toBe("IN (1, 3)");
  });

  it("returns null when nothing is convertible", () => {
    expect(toSqlIn([{ a: 1 }, [1]])).toBeNull();
  });
});

describe("sqlInFromJson", () => {
  it("converts a string array end-to-end", () => {
    const r = sqlInFromJson('["x", "y"]');
    expect(r.ok).toBe(true);
    expect(r.sql).toBe("IN ('x', 'y')");
  });

  it("converts a number array end-to-end", () => {
    const r = sqlInFromJson("[10, 20]");
    expect(r.ok).toBe(true);
    expect(r.sql).toBe("IN (10, 20)");
  });

  it("auto-picks id field for object arrays", () => {
    const r = sqlInFromJson('[{"id":1,"name":"a"},{"id":2,"name":"b"}]');
    expect(r.ok).toBe(true);
    expect(r.sql).toBe("IN (1, 2)");
  });

  it("uses explicit field for object arrays", () => {
    const r = sqlInFromJson('[{"id":1,"name":"a"},{"id":2,"name":"b"}]', { field: "name" });
    expect(r.ok).toBe(true);
    expect(r.sql).toBe("IN ('a', 'b')");
  });

  it("respects quote and wrap options together", () => {
    const r = sqlInFromJson('["a"]', { quote: "double", wrap: "values" });
    expect(r.ok).toBe(true);
    expect(r.sql).toBe('"a"');
  });

  it("reports invalid JSON", () => {
    const r = sqlInFromJson("{oops");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("JSON 解析失败");
  });

  it("reports non-array", () => {
    const r = sqlInFromJson('{"id":1}');
    expect(r.ok).toBe(false);
    expect(r.message).toContain("不是 JSON 数组");
  });

  it("reports empty array", () => {
    const r = sqlInFromJson("[]");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("数组为空");
  });
});
