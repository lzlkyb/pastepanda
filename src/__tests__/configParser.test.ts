/**
 * configParser 的单测。
 *
 * 抽到 `lib/` 的理由（规则 #11）：这三个是纯函数，原先内联在 ConfigEditor.tsx 里，
 * 既不可测、也和「LogEditor 复用 lib/logParser.ts」的既有做法不一致。
 *
 * 用例覆盖的是真实配置文件里那些容易错的地方：带引号的值、`:` 与 `=` 两种分隔符、
 * ini 的 section 归属、注释与空行必须原样保留（不能因为解析而改写用户文件）。
 */
import { describe, it, expect } from "vitest";
import { parseConfig, emitLine, detectFormat } from "@/lib/configParser";

describe("parseConfig", () => {
  it("行数与原文一一对应（index 即行号）", () => {
    const text = "a=1\n\n# c\n[s]\nb: 2";
    expect(parseConfig(text)).toHaveLength(5);
  });

  it("识别 = 与 : 两种分隔符，并记住用的是哪个", () => {
    const [eq, colon] = parseConfig("a=1\nb: 2");
    expect(eq).toMatchObject({ type: "kv", key: "a", value: "1", sep: "=" });
    expect(colon).toMatchObject({ type: "kv", key: "b", value: "2", sep: ":" });
  });

  it("剥掉值的引号但记住引号类型（回写时要还原）", () => {
    const [d, s] = parseConfig(`a="x y"\nb='z'`);
    expect(d).toMatchObject({ value: "x y", quote: '"' });
    expect(s).toMatchObject({ value: "z", quote: "'" });
  });

  it("kv 行归属到最近的 section", () => {
    const lines = parseConfig("[db]\nhost=1\n[web]\nport=2");
    expect(lines[1]).toMatchObject({ type: "kv", section: "db" });
    expect(lines[3]).toMatchObject({ type: "kv", section: "web" });
  });

  it("注释、空行、无法解析的行都原样保留", () => {
    const lines = parseConfig("# 注释\n;分号注释\n\n这行不是键值");
    expect(lines[0]).toMatchObject({ type: "comment", raw: "# 注释" });
    expect(lines[1]).toMatchObject({ type: "comment", raw: ";分号注释" });
    expect(lines[2].type).toBe("blank");
    expect(lines[3]).toMatchObject({ type: "other", raw: "这行不是键值" });
  });

  it("key 允许点 / 斜杠 / 连字符（真实配置里常见）", () => {
    const [a, b, c] = parseConfig("log.level=info\npath/to=x\nmy-key=y");
    expect(a).toMatchObject({ key: "log.level" });
    expect(b).toMatchObject({ key: "path/to" });
    expect(c).toMatchObject({ key: "my-key" });
  });

  it("值里含 = 或 : 不会被截断", () => {
    expect(parseConfig("url=http://a.com:8080/x?y=1")[0]).toMatchObject({
      value: "http://a.com:8080/x?y=1",
    });
  });
});

describe("emitLine", () => {
  it("非 kv 行原样吐回（注释不能被改写）", () => {
    const [c] = parseConfig("# 注释");
    expect(emitLine(c, "irrelevant", "irrelevant")).toBe("# 注释");
  });

  it("kv 行按最新 key/value 重建，并还原引号", () => {
    const [d] = parseConfig(`a="x"`);
    expect(emitLine(d, "a", "y")).toBe('a="y"');
  });

  it("原本没引号就不加引号", () => {
    const [d] = parseConfig("a: 1");
    expect(emitLine(d, "a", "2")).toBe("a: 2");
  });

  // 下面几条钉的是「改一个值不许顺手格式化整行」。
  // 尤其 KEY=value：一旦被写成 KEY= value，`source .env` 在 bash 里会解析成
  // KEY="" 然后把 value 当命令跑，docker --env-file 也不 trim 值。
  it("KEY=value 回写后分隔符两侧不许多出空格", () => {
    const [d] = parseConfig("API_KEY=abc");
    expect(emitLine(d, "API_KEY", "xyz")).toBe("API_KEY=xyz");
  });

  it("原本 key = value 的对齐空格照原样保留", () => {
    const [d] = parseConfig("host   =   localhost");
    expect(emitLine(d, "host", "127.0.0.1")).toBe("host   =   127.0.0.1");
  });

  it("ini 的缩进不许被吞掉", () => {
    const [d] = parseConfig("    level=info");
    expect(emitLine(d, "level", "debug")).toBe("    level=debug");
  });

  it("CRLF 行尾的 \\r 不许进 value，也不许在回写时丢掉", () => {
    const [d] = parseConfig("KEY=value\r");
    expect(d).toMatchObject({ type: "kv", value: "value", trail: "\r" });
    expect(emitLine(d, "KEY", "v2")).toBe("KEY=v2\r");
  });

  it("值本身末尾的空格在引号内时保留", () => {
    const [d] = parseConfig(`pad="a "`);
    expect(d).toMatchObject({ value: "a " });
    expect(emitLine(d, "pad", "b ")).toBe('pad="b "');
  });
});

describe("detectFormat", () => {
  it("有 section 头判 INI", () => {
    expect(detectFormat("[db]\nhost=1")).toBe("INI");
  });
  it("全大写 key + = 判 ENV", () => {
    expect(detectFormat("API_KEY=abc")).toBe("ENV");
  });
  it("key: value 判 YAML/TOML", () => {
    expect(detectFormat("host: localhost")).toBe("YAML/TOML");
  });
  it("都不像时回退「通用」", () => {
    expect(detectFormat("随便一段文本")).toBe("通用");
  });
});
