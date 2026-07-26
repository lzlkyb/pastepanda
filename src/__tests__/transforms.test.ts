import { describe, it, expect } from "vitest";
import { parseColumnList, isColumnList } from "@/lib/transforms/detectors";
import { jsonToInsert } from "@/lib/transforms/jsonInsert";
import {
  listTransforms, getTransform, registerTransform, applicableTransforms,
} from "@/lib/transforms/registry";
import type { Transform } from "@/lib/transforms/types";
// 触发内置变换注册（sql-in / column-to-sql-in / json-insert）
import "@/lib/transforms";

describe("parseColumnList", () => {
  it("parses a numeric column", () => {
    const info = parseColumnList("1001\n1002\n1003");
    expect(info.ok).toBe(true);
    expect(info.count).toBe(3);
    expect(info.allNumeric).toBe(true);
    expect(info.values).toEqual([1001, 1002, 1003]);
  });

  it("parses a string column", () => {
    const info = parseColumnList("alice\nbob");
    expect(info.ok).toBe(true);
    expect(info.allNumeric).toBe(false);
    expect(info.values).toEqual(["alice", "bob"]);
  });

  it("trims lines and skips empties", () => {
    const info = parseColumnList("  a  \n\n  b  \n");
    expect(info.ok).toBe(true);
    expect(info.count).toBe(2);
    expect(info.values).toEqual(["a", "b"]);
  });

  it("handles CRLF line endings", () => {
    const info = parseColumnList("1\r\n2\r\n3");
    expect(info.ok).toBe(true);
    expect(info.count).toBe(3);
  });

  it("rejects a single line", () => {
    expect(parseColumnList("onlyone").ok).toBe(false);
  });

  it("rejects empty text", () => {
    expect(parseColumnList("").ok).toBe(false);
    expect(parseColumnList("\n\n").ok).toBe(false);
  });

  it("rejects lines with inner whitespace", () => {
    expect(parseColumnList("hello world\nfoo bar").ok).toBe(false);
  });

  it("rejects json-like lines", () => {
    expect(parseColumnList("[1,\n2,\n3]").ok).toBe(false);
    expect(parseColumnList('{"a":1}\n{"a":2}').ok).toBe(false);
  });

  it("isColumnList helper agrees", () => {
    expect(isColumnList("1\n2\n3")).toBe(true);
    expect(isColumnList("nope")).toBe(false);
  });
});

describe("jsonToInsert", () => {
  it("object array → multi-column insert", () => {
    const r = jsonToInsert('[{"id":1,"name":"a"},{"id":2,"name":"b"}]');
    expect(r.ok).toBe(true);
    expect(r.sql).toBe("INSERT INTO table_name (id, name) VALUES (1, 'a'), (2, 'b');");
    expect(r.count).toBe(2);
  });

  it("escapes single quotes", () => {
    const r = jsonToInsert('[{"n":"O\'Brien"}]');
    expect(r.ok).toBe(true);
    expect(r.sql).toContain("'O''Brien'");
  });

  it("honors custom table name", () => {
    const r = jsonToInsert('[{"id":1}]', { table: "users" });
    expect(r.sql).toBe("INSERT INTO users (id) VALUES (1);");
  });

  it("maps null to NULL", () => {
    const r = jsonToInsert('[{"id":1,"x":null}]');
    expect(r.sql).toBe("INSERT INTO table_name (id, x) VALUES (1, NULL);");
  });

  it("maps boolean to 1/0", () => {
    const r = jsonToInsert('[{"f":true},{"f":false}]');
    expect(r.sql).toBe("INSERT INTO table_name (f) VALUES (1), (0);");
  });

  it("supports double-quote style", () => {
    const r = jsonToInsert('[{"a":"x"}]', { quote: "double" });
    expect(r.sql).toBe('INSERT INTO table_name (a) VALUES ("x");');
  });

  it("scalar array → single column named value", () => {
    const r = jsonToInsert("[1,2,3]");
    expect(r.ok).toBe(true);
    expect(r.sql).toBe("INSERT INTO table_name (value) VALUES (1), (2), (3);");
    expect(r.count).toBe(3);
  });

  it("scalar array honors custom column", () => {
    const r = jsonToInsert("[1,2]", { scalarColumn: "id" });
    expect(r.sql).toBe("INSERT INTO table_name (id) VALUES (1), (2);");
  });

  it("quotes string scalars", () => {
    const r = jsonToInsert('["a","b"]');
    expect(r.sql).toBe("INSERT INTO table_name (value) VALUES ('a'), ('b');");
  });

  it("fails on invalid json", () => {
    const r = jsonToInsert("{bad");
    expect(r.ok).toBe(false);
    expect(r.message).toBe("JSON 解析失败");
  });

  it("fails on non-array", () => {
    const r = jsonToInsert('{"a":1}');
    expect(r.ok).toBe(false);
    expect(r.message).toBe("内容不是 JSON 数组");
  });

  it("fails on empty array", () => {
    const r = jsonToInsert("[]");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("数组为空");
  });
});

describe("transform registry", () => {
  it("registers the built-in transforms", () => {
    const ids = listTransforms().map((t) => t.id);
    expect(ids).toContain("sql-in");
    expect(ids).toContain("column-to-sql-in");
    expect(ids).toContain("json-insert");
  });

  it("looks up a transform by id", () => {
    expect(getTransform("sql-in")?.label).toBe("SQL IN");
    expect(getTransform("nope")).toBeUndefined();
  });

  it("allows registering a new transform", () => {
    const dummy: Transform = {
      id: "test-dummy",
      label: "Dummy",
      group: "text",
      detect: () => 0,
      run: () => ({ ok: true, output: "x" }),
    };
    registerTransform(dummy);
    expect(getTransform("test-dummy")).toBeDefined();
  });

  it("ranks json-array transforms with sql-in on top", () => {
    const scored = applicableTransforms({ text: '["a","b"]', contentType: "json" });
    const ids = scored.map((s) => s.transform.id);
    expect(ids).toContain("sql-in");
    expect(ids).toContain("json-insert");
    expect(scored[0].transform.id).toBe("sql-in");
  });

  it("plain text matches only generic text transforms (no specialized ones)", () => {
    const scored = applicableTransforms({ text: "hello world", contentType: "text" });
    const ids = scored.map((s) => s.transform.id);
    // 通用文本变换命中（基线分）
    expect(ids).toContain("upper");
    expect(ids).toContain("lower");
    expect(ids).toContain("quote");
    // 专业变换不命中
    expect(ids).not.toContain("sql-in");
    expect(ids).not.toContain("json-insert");
    expect(ids).not.toContain("color_hex");
    expect(ids).not.toContain("md_link");
  });

  it("finds column-to-sql-in for a column of values", () => {
    const scored = applicableTransforms({ text: "1\n2\n3", contentType: "text" });
    const ids = scored.map((s) => s.transform.id);
    expect(ids).toContain("column-to-sql-in");
    expect(ids).not.toContain("sql-in");
  });

  it("sql-in detect is 0 for non-json contentType", () => {
    expect(getTransform("sql-in")!.detect({ text: '["a"]', contentType: "text" })).toBe(0);
  });

  it("sql-in run outputs an IN clause", () => {
    const r = getTransform("sql-in")!.run('["a","b"]');
    expect(r.ok).toBe(true);
    expect(r.output).toBe("IN ('a', 'b')");
  });

  it("column-to-sql-in run outputs an IN clause", () => {
    const r = getTransform("column-to-sql-in")!.run("1\n2");
    expect(r.ok).toBe(true);
    expect(r.output).toBe("IN (1, 2)");
  });

  it("json-insert run outputs an INSERT statement", () => {
    const r = getTransform("json-insert")!.run('[{"id":1}]');
    expect(r.ok).toBe(true);
    expect(r.output).toBe("INSERT INTO table_name (id) VALUES (1);");
  });
});

describe("sql-in dynamic field options (optionsFor)", () => {
  const objArray = '[{"id":1,"name":"a"},{"id":2,"name":"b"}]';

  it("object array → field spec lists real fields, defaults to id-like", () => {
    const t = getTransform("sql-in")!;
    const specs = t.optionsFor!({ text: objArray, contentType: "json" });
    const field = specs.find((s) => s.key === "field");
    expect(field).toBeDefined();
    expect(field!.values.map((v) => v.value)).toEqual(["id", "name"]);
    expect(field!.default).toBe("id");
  });

  it("scalar array → no field spec", () => {
    const t = getTransform("sql-in")!;
    const specs = t.optionsFor!({ text: "[1,2,3]", contentType: "json" });
    expect(specs.find((s) => s.key === "field")).toBeUndefined();
  });

  it("selecting a field drives run output", () => {
    const t = getTransform("sql-in")!;
    expect(t.run(objArray, { field: "name" }).output).toBe("IN ('a', 'b')");
    expect(t.run(objArray, { field: "id" }).output).toBe("IN (1, 2)");
  });

  it("default (no field opt) picks the id-like field", () => {
    const t = getTransform("sql-in")!;
    expect(t.run(objArray).output).toBe("IN (1, 2)");
  });
});
