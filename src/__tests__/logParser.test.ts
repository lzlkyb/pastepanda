import { describe, it, expect } from "vitest";
import { parseLog, filterEntries, LEVEL_ORDER } from "@/lib/logParser";

describe("parseLog — 应用日志（ISO 时间戳 + 级别）", () => {
  const APP_LOG = [
    "2026-07-25 21:03:12.123 [main] INFO  Server started on :8080",
    "2026-07-25 21:03:13.456 [worker-1] DEBUG loading config",
    "2026-07-25 21:03:14.789 [worker-2] ERROR failed to connect db",
    "2026-07-25 21:03:15.000 [worker-2] WARN  retrying in 3s",
  ].join("\n");

  it("parses time / level / msg for each line", () => {
    const { entries } = parseLog(APP_LOG);
    expect(entries).toHaveLength(4);
    expect(entries[0].time).toBe("2026-07-25 21:03:12.123");
    expect(entries[0].level).toBe("INFO");
    expect(entries[0].msg).toBe("[main] INFO  Server started on :8080");
    expect(entries[2].level).toBe("ERROR");
    expect(entries[3].level).toBe("WARN");
  });

  it("aggregates level counts and totalLines", () => {
    const { counts, totalLines } = parseLog(APP_LOG);
    expect(counts).toEqual({ INFO: 1, DEBUG: 1, ERROR: 1, WARN: 1 });
    expect(totalLines).toBe(4);
  });
});

describe("parseLog — 时间戳格式（与 Rust 分类器同源）", () => {
  it("normalizes bracketed ISO timestamp (T → space, brackets stripped)", () => {
    const { entries } = parseLog("[2026-07-25T21:03:12] INFO ok");
    expect(entries[0].time).toBe("2026-07-25 21:03:12");
    expect(entries[0].level).toBe("INFO");
  });

  it("parses MM/DD HH:MM:SS format", () => {
    const { entries } = parseLog("07/25 21:03:12 ERROR disk full");
    expect(entries[0].time).toBe("07/25 21:03:12");
    expect(entries[0].level).toBe("ERROR");
  });

  it("parses nginx access log (no level)", () => {
    const line = '[25/Jul/2026:21:03:12 +0800] "GET /api/items HTTP/1.1" 200 512';
    const { entries } = parseLog(line);
    expect(entries[0].time).toBe("25/Jul/2026:21:03:12");
    expect(entries[0].level).toBeNull();
    expect(entries[0].msg).toBe('"GET /api/items HTTP/1.1" 200 512');
  });

  it("parses syslog format (no level)", () => {
    const { entries } = parseLog("Jul 25 21:03:12 myhost sshd[1234]: Accepted password");
    expect(entries[0].time).toBe("Jul 25 21:03:12");
    expect(entries[0].level).toBeNull();
    expect(entries[0].msg).toBe("myhost sshd[1234]: Accepted password");
  });
});

describe("parseLog — 级别归一化", () => {
  it("WARNING → WARN", () => {
    expect(parseLog("2026-07-25 21:03:12 WARNING low disk").entries[0].level).toBe("WARN");
  });

  it("CRITICAL → FATAL", () => {
    expect(parseLog("2026-07-25 21:03:12 CRITICAL kernel panic").entries[0].level).toBe("FATAL");
  });

  it("NOTICE → INFO", () => {
    expect(parseLog("2026-07-25 21:03:12 NOTICE reload done").entries[0].level).toBe("INFO");
  });

  it("lowercase level keywords are recognized", () => {
    expect(parseLog("2026-07-25 21:03:12 error something broke").entries[0].level).toBe("ERROR");
  });

  it("LEVEL_ORDER covers all normalized levels in severity order", () => {
    expect(LEVEL_ORDER).toEqual(["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"]);
  });
});

describe("parseLog — 续行与空行", () => {
  it("attaches stack-trace lines to previous entry as cont", () => {
    const text = [
      "2026-07-25 21:03:14.789 ERROR failed to connect db",
      "    at DbPool.connect (pool.ts:42)",
      "    at async init (main.ts:10)",
      "2026-07-25 21:03:15.000 INFO  recovered",
    ].join("\n");
    const { entries } = parseLog(text);
    expect(entries).toHaveLength(2);
    expect(entries[0].cont).toEqual([
      "    at DbPool.connect (pool.ts:42)",
      "    at async init (main.ts:10)",
    ]);
    expect(entries[1].cont).toEqual([]);
  });

  it("skips blank lines but counts them in totalLines", () => {
    const text = "2026-07-25 21:03:12 INFO a\n\n\n2026-07-25 21:03:13 INFO b\n";
    const { entries, totalLines } = parseLog(text);
    expect(entries).toHaveLength(2);
    expect(totalLines).toBe(5); // 末尾换行产生一个空段
  });

  it("leading line without timestamp becomes a level-only entry", () => {
    const { entries } = parseLog("WARN no timestamp here");
    expect(entries).toHaveLength(1);
    expect(entries[0].time).toBeNull();
    expect(entries[0].level).toBe("WARN");
    expect(entries[0].msg).toBe("WARN no timestamp here");
  });
});

describe("filterEntries", () => {
  const { entries } = parseLog(
    [
      "2026-07-25 21:03:12 INFO  user login ok",
      "2026-07-25 21:03:13 ERROR Timeout waiting for response",
      "    at fetchUser (api.ts:7)",
      "Jul 25 21:03:14 myhost cron: job done",
    ].join("\n")
  );

  it("null levels + empty keyword returns everything", () => {
    expect(filterEntries(entries, null, "")).toHaveLength(3);
  });

  it("level set keeps only matching entries and hides no-level ones", () => {
    const only = filterEntries(entries, new Set(["ERROR"]), "");
    expect(only).toHaveLength(1);
    expect(only[0].level).toBe("ERROR");
  });

  it("multi-level set unions results", () => {
    const some = filterEntries(entries, new Set(["INFO", "ERROR"]), "");
    expect(some).toHaveLength(2);
  });

  it("keyword is case-insensitive and matches msg", () => {
    expect(filterEntries(entries, null, "timeout")).toHaveLength(1);
    expect(filterEntries(entries, null, "TIMEOUT")[0].level).toBe("ERROR");
  });

  it("keyword matches continuation lines", () => {
    expect(filterEntries(entries, null, "fetchUser")).toHaveLength(1);
  });

  it("keyword matches timestamp text", () => {
    expect(filterEntries(entries, null, "21:03:12")).toHaveLength(1);
  });

  it("level + keyword combine as AND", () => {
    expect(filterEntries(entries, new Set(["INFO"]), "timeout")).toHaveLength(0);
    expect(filterEntries(entries, new Set(["ERROR"]), "timeout")).toHaveLength(1);
  });
});
