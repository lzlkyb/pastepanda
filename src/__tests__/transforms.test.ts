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
    expect(info.values).toEqual(["1001", "1002", "1003"]);
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

  it("sql-in run outputs an IN clause", async () => {
    const r = await getTransform("sql-in")!.run('["a","b"]');
    expect(r.ok).toBe(true);
    expect(r.output).toBe("IN ('a', 'b')");
  });

  it("column-to-sql-in run outputs an IN clause", async () => {
    const r = await getTransform("column-to-sql-in")!.run("1\n2");
    expect(r.ok).toBe(true);
    expect(r.output).toBe("IN ('1', '2')");
  });

  it("json-insert run outputs an INSERT statement", async () => {
    const r = await getTransform("json-insert")!.run('[{"id":1}]');
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

  it("selecting a field drives run output", async () => {
    const t = getTransform("sql-in")!;
    expect((await t.run(objArray, { field: "name" })).output).toBe("IN ('a', 'b')");
    expect((await t.run(objArray, { field: "id" })).output).toBe("IN (1, 2)");
  });

  it("default (no field opt) picks the id-like field", async () => {
    const t = getTransform("sql-in")!;
    expect((await t.run(objArray)).output).toBe("IN (1, 2)");
  });
});

// ============ 编解码工具组 ============

describe("codec transforms", () => {
  it("base64 encode/decode round-trip", async () => {
    const enc = getTransform("base64_encode")!;
    const dec = getTransform("base64_decode")!;
    const r1 = await enc.run("Hello 世界");
    expect(r1.ok).toBe(true);
    const r2 = await dec.run(r1.output!);
    expect(r2.ok).toBe(true);
    expect(r2.output).toBe("Hello 世界");
  });

  it("base64 decode detects base64 text", () => {
    const t = getTransform("base64_decode")!;
    expect(t.detect({ text: "SGVsbG8=", contentType: "text" })).toBeGreaterThan(0.5);
    expect(t.detect({ text: "not base64!!!", contentType: "text" })).toBe(0);
  });

  it("url encode/decode round-trip", async () => {
    const enc = getTransform("url_encode")!;
    const dec = getTransform("url_decode")!;
    const r1 = await enc.run("hello world&foo=bar");
    expect(r1.output).toBe("hello%20world%26foo%3Dbar");
    const r2 = await dec.run(r1.output!);
    expect(r2.output).toBe("hello world&foo=bar");
  });

  it("url decode detects %XX patterns", () => {
    const t = getTransform("url_decode")!;
    expect(t.detect({ text: "hello%20world", contentType: "text" })).toBeGreaterThan(0.5);
    expect(t.detect({ text: "plain text", contentType: "text" })).toBe(0);
  });

  it("unicode encode/decode round-trip", async () => {
    const enc = getTransform("unicode_encode")!;
    const dec = getTransform("unicode_decode")!;
    const r1 = await enc.run("你好ABC");
    expect(r1.output).toContain("\\u4F60");
    expect(r1.output).toContain("ABC"); // ASCII 不编码
    const r2 = await dec.run(r1.output!);
    expect(r2.output).toBe("你好ABC");
  });

  it("html encode/decode round-trip", async () => {
    const enc = getTransform("html_encode")!;
    const dec = getTransform("html_decode")!;
    const r1 = await enc.run('<div class="test">&</div>');
    expect(r1.output).toContain("&lt;");
    expect(r1.output).toContain("&amp;");
    const r2 = await dec.run(r1.output!);
    expect(r2.output).toBe('<div class="test">&</div>');
  });

  it("html decode handles numeric entities", async () => {
    const dec = getTransform("html_decode")!;
    const r = await dec.run("&#65;&#x42;&#67;");
    expect(r.output).toBe("ABC");
  });

  it("jwt decode parses header and payload", async () => {
    // 构造一个简单 JWT（不验证签名）
    const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = btoa(JSON.stringify({ sub: "1234", name: "Test", iat: 1700000000 }));
    const jwt = `${header}.${payload}.fakesig`;
    const t = getTransform("jwt_decode")!;
    expect(t.detect({ text: jwt, contentType: "text" })).toBeGreaterThan(0.9);
    const r = await t.run(jwt);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('"alg": "HS256"');
    expect(r.output).toContain('"name": "Test"');
    expect(r.output).toContain("iat_readable");
  });

  it("timestamp to date converts correctly", async () => {
    const t = getTransform("timestamp_to_date")!;
    expect(t.detect({ text: "1700000000", contentType: "number" })).toBeGreaterThan(0.5);
    const r = await t.run("1700000000");
    expect(r.ok).toBe(true);
    expect(r.output).toContain("2023-11-14");
  });

  it("date to timestamp converts correctly", async () => {
    const t = getTransform("date_to_timestamp")!;
    expect(t.detect({ text: "2023-11-14T22:13:20Z", contentType: "text" })).toBeGreaterThan(0.5);
    const r = await t.run("2023-11-14T22:13:20Z");
    expect(r.ok).toBe(true);
    expect(r.output).toContain("1700000000");
  });

  it("all 11 codec transforms are registered", () => {
    const ids = [
      "base64_encode", "base64_decode", "url_encode", "url_decode",
      "unicode_encode", "unicode_decode", "html_encode", "html_decode",
      "jwt_decode", "timestamp_to_date", "date_to_timestamp",
    ];
    for (const id of ids) {
      expect(getTransform(id), `transform ${id} should be registered`).toBeDefined();
    }
  });
});

// ============ 日志统计工具 ============

const SAMPLE_LOG = [
  "2026-07-25 10:00:01 INFO  Server started on port 8080",
  "2026-07-25 10:00:02 DEBUG Loading config from /etc/app.conf",
  "2026-07-25 10:00:03 WARN  Disk usage above 80%",
  "2026-07-25 10:00:04 ERROR Connection refused: db-host:5432",
  "  at Pool.connect (pool.js:42)",
  "2026-07-25 10:00:05 ERROR Connection refused: db-host:5432",
  "2026-07-25 10:00:06 FATAL Out of memory",
  "2026-07-25 10:00:07 INFO  Shutdown complete",
].join("\n");

describe("log transforms", () => {
  it("log_stats produces level distribution and summary", async () => {
    const t = getTransform("log_stats")!;
    const r = await t.run(SAMPLE_LOG);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("日志统计");
    expect(r.output).toContain("条目数: 7");
    expect(r.output).toContain("INFO");
    expect(r.output).toContain("ERROR");
    expect(r.output).toContain("高频错误");
    expect(r.output).toContain("[2x]");
    expect(r.meta?.count).toBe(7);
  });

  it("log_stats shows time range", async () => {
    const t = getTransform("log_stats")!;
    const r = await t.run(SAMPLE_LOG);
    expect(r.output).toContain("10:00:01");
    expect(r.output).toContain("10:00:07");
  });

  it("log_errors extracts only ERROR/FATAL entries", async () => {
    const t = getTransform("log_errors")!;
    const r = await t.run(SAMPLE_LOG);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("Connection refused");
    expect(r.output).toContain("Out of memory");
    expect(r.output).not.toContain("Server started");
    expect(r.output).not.toContain("Loading config");
    expect(r.meta?.count).toBe(3);
  });

  it("log_errors includes continuation lines", async () => {
    const t = getTransform("log_errors")!;
    const r = await t.run(SAMPLE_LOG);
    expect(r.output).toContain("pool.js:42");
  });

  it("detect scores: log contentType high, plain text zero", () => {
    const t = getTransform("log_stats")!;
    expect(t.detect({ text: SAMPLE_LOG, contentType: "log" })).toBeGreaterThan(0.9);
    expect(t.detect({ text: SAMPLE_LOG, contentType: "text" })).toBeGreaterThan(0.8);
    expect(t.detect({ text: "hello world", contentType: "text" })).toBe(0);
  });

  it("log_stats fails on empty text", async () => {
    const t = getTransform("log_stats")!;
    const r = await t.run("");
    expect(r.ok).toBe(false);
  });

  it("log_errors fails when no errors found", async () => {
    const t = getTransform("log_errors")!;
    const r = await t.run("2026-01-01 00:00:00 INFO all good");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("未发现");
  });

  it("both log transforms are registered", () => {
    expect(getTransform("log_stats")).toBeDefined();
    expect(getTransform("log_errors")).toBeDefined();
  });
});
