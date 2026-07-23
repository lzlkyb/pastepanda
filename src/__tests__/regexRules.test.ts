import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  PRESET_RULES,
  loadCustomRules,
  saveCustomRules,
  getAllRules,
  getEnabledRules,
  togglePresetRule,
  addCustomRule,
  updateCustomRule,
  deleteCustomRule,
  toggleCustomRule,
  applyRegex,
  safeApplyRegex,
  validateRegex,
  REGEX_TIME_BUDGET_MS,
  RegexRule,
} from "@/lib/regexRules";

// ============================================================
// 辅助
// ============================================================
const STORAGE_KEY = "pp_regex_rules";

beforeEach(() => {
  localStorage.clear();
});

// ============================================================
// 预设规则
// ============================================================
describe("PRESET_RULES", () => {
  it("has 8 preset rules with unique ids", () => {
    expect(PRESET_RULES).toHaveLength(8);
    const ids = new Set(PRESET_RULES.map((r) => r.id));
    expect(ids.size).toBe(8);
  });

  it("all presets are marked preset=true and enabled by default", () => {
    for (const r of PRESET_RULES) {
      expect(r.preset).toBe(true);
      expect(r.enabled).toBe(true);
    }
  });
});

// ============================================================
// CRUD — 自定义规则
// ============================================================
describe("custom rules CRUD", () => {
  it("loadCustomRules returns empty when no storage", () => {
    expect(loadCustomRules()).toEqual([]);
  });

  it("loadCustomRules returns empty on corrupt JSON", () => {
    localStorage.setItem(STORAGE_KEY, "{invalid");
    expect(loadCustomRules()).toEqual([]);
  });

  it("saveCustomRules + loadCustomRules round-trip", () => {
    const rules: RegexRule[] = [
      { id: "c1", name: "test", pattern: "\\d+", replacement: "#", flags: "g", enabled: true, preset: false },
    ];
    saveCustomRules(rules);
    expect(loadCustomRules()).toEqual(rules);
  });

  it("addCustomRule appends and persists", () => {
    const rule = addCustomRule({ name: "new", pattern: "a", replacement: "b", flags: "g", enabled: true });
    expect(rule.id).toMatch(/^c_\d+$/);
    expect(rule.preset).toBe(false);
    expect(loadCustomRules()).toHaveLength(1);
    expect(loadCustomRules()[0].name).toBe("new");
  });

  it("updateCustomRule patches fields", () => {
    const rule = addCustomRule({ name: "orig", pattern: "x", replacement: "y", flags: "", enabled: true });
    updateCustomRule(rule.id, { name: "updated", flags: "gi" });
    const loaded = loadCustomRules();
    expect(loaded[0].name).toBe("updated");
    expect(loaded[0].flags).toBe("gi");
    expect(loaded[0].pattern).toBe("x"); // 未改字段保持
  });

  it("updateCustomRule is no-op for nonexistent id", () => {
    addCustomRule({ name: "a", pattern: "x", replacement: "y", flags: "", enabled: true });
    updateCustomRule("nonexist", { name: "z" });
    expect(loadCustomRules()[0].name).toBe("a");
  });

  it("deleteCustomRule removes by id", () => {
    // mock Date.now 确保两次 addCustomRule 生成不同 id
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValueOnce(now).mockReturnValueOnce(now + 1);
    const r1 = addCustomRule({ name: "a", pattern: "1", replacement: "", flags: "", enabled: true });
    const r2 = addCustomRule({ name: "b", pattern: "2", replacement: "", flags: "", enabled: true });
    expect(r1.id).not.toBe(r2.id);
    deleteCustomRule(r1.id);
    const loaded = loadCustomRules();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe("b");
    vi.restoreAllMocks();
  });

  it("toggleCustomRule flips enabled", () => {
    const rule = addCustomRule({ name: "t", pattern: "x", replacement: "", flags: "", enabled: true });
    toggleCustomRule(rule.id);
    expect(loadCustomRules()[0].enabled).toBe(false);
    toggleCustomRule(rule.id);
    expect(loadCustomRules()[0].enabled).toBe(true);
  });
});

// ============================================================
// getAllRules / getEnabledRules / togglePresetRule
// ============================================================
describe("getAllRules / getEnabledRules", () => {
  it("returns presets + custom combined", () => {
    addCustomRule({ name: "c", pattern: "x", replacement: "", flags: "", enabled: true });
    const all = getAllRules();
    expect(all).toHaveLength(PRESET_RULES.length + 1);
    // 预设在前面
    expect(all[0].preset).toBe(true);
    expect(all[all.length - 1].preset).toBe(false);
  });

  it("getEnabledRules filters disabled", () => {
    const rule = addCustomRule({ name: "off", pattern: "x", replacement: "", flags: "", enabled: false });
    const enabled = getEnabledRules();
    expect(enabled.find((r) => r.id === rule.id)).toBeUndefined();
  });

  it("togglePresetRule persists disabled state", () => {
    togglePresetRule("p1");
    const all = getAllRules();
    const p1 = all.find((r) => r.id === "p1")!;
    expect(p1.enabled).toBe(false);

    // 再切回来
    togglePresetRule("p1");
    const all2 = getAllRules();
    expect(all2.find((r) => r.id === "p1")!.enabled).toBe(true);
  });

  it("togglePresetRule is no-op for unknown id", () => {
    togglePresetRule("nonexist");
    // 不应抛错，预设状态不变
    expect(getAllRules().filter((r) => r.preset && r.enabled)).toHaveLength(PRESET_RULES.length);
  });
});

// ============================================================
// applyRegex
// ============================================================
describe("applyRegex", () => {
  it("basic replace with match count", () => {
    const { result, matchCount } = applyRegex("hello world hello", "hello", "hi", "g");
    expect(result).toBe("hi world hi");
    expect(matchCount).toBe(2);
  });

  it("non-global replaces only first", () => {
    const { result, matchCount } = applyRegex("aaa", "a", "b", "");
    expect(result).toBe("baa");
    expect(matchCount).toBe(1);
  });

  it("case-insensitive flag", () => {
    const { result } = applyRegex("Hello HELLO", "hello", "x", "gi");
    expect(result).toBe("x x");
  });

  it("URL decode special replacement", () => {
    const { result, matchCount } = applyRegex("%48%65%6C%6C%6F", "%([0-9A-Fa-f]{2})", "__URL_DECODE__", "g");
    expect(result).toBe("Hello");
    expect(matchCount).toBe(5);
  });

  it("URL decode with invalid encoding returns original", () => {
    const { result, matchCount } = applyRegex("%ZZ invalid", "%([0-9A-Fa-f]{2})", "__URL_DECODE__", "g");
    expect(result).toBe("%ZZ invalid");
    expect(matchCount).toBe(0);
  });

  it("no match returns original text with count 0", () => {
    const { result, matchCount } = applyRegex("hello", "\\d+", "#", "g");
    expect(result).toBe("hello");
    expect(matchCount).toBe(0);
  });

  it("group references in replacement", () => {
    const { result } = applyRegex("2026-07-22", "(\\d{4})-(\\d{2})-(\\d{2})", "$3/$2/$1", "");
    expect(result).toBe("22/07/2026");
  });
});

// ============================================================
// safeApplyRegex
// ============================================================
describe("safeApplyRegex", () => {
  it("produces same result as applyRegex for normal input", () => {
    const text = "line1\nline2\nline3";
    const { result, matchCount } = safeApplyRegex(text, "line", "row", "g");
    expect(result).toBe("row1\nrow2\nrow3");
    expect(matchCount).toBe(3);
  });

  it("truncates text exceeding maxLen", () => {
    const long = "a".repeat(200);
    const { result, truncated } = safeApplyRegex(long, "a", "b", "g", 100);
    expect(truncated).toBe(true);
    expect(result).toBe("b".repeat(100));
  });

  it("truncated=false for short text", () => {
    const { truncated } = safeApplyRegex("short", "x", "y", "g");
    expect(truncated).toBe(false);
  });

  it("non-global replaces only first across chunks", () => {
    // 构造超过 CHUNK_LINES(20) 行的文本
    const lines = Array.from({ length: 40 }, (_, i) => `line${i}\n`).join("");
    const { result, matchCount } = safeApplyRegex(lines, "line", "ROW", "");
    expect(matchCount).toBe(1);
    expect(result).toContain("ROW0");
    expect(result).toContain("line1"); // 后续不替换
  });

  it("multiline flag preserves ^ anchor semantics", () => {
    const text = "hello\nworld\nhello";
    const { result, matchCount } = safeApplyRegex(text, "^hello", "hi", "gm");
    expect(result).toBe("hi\nworld\nhi");
    expect(matchCount).toBe(2);
  });

  it("throws on invalid regex", () => {
    expect(() => safeApplyRegex("text", "[invalid", "", "g")).toThrow("正则执行失败");
  });

  it("URL decode special handling", () => {
    const { result } = safeApplyRegex("%41%42%43", "%([0-9A-Fa-f]{2})", "__URL_DECODE__", "g");
    expect(result).toBe("ABC");
  });

  it("handles empty text", () => {
    const { result, matchCount } = safeApplyRegex("", "x", "y", "g");
    expect(result).toBe("");
    expect(matchCount).toBe(0);
  });

  it("REGEX_TIME_BUDGET_MS is 300", () => {
    expect(REGEX_TIME_BUDGET_MS).toBe(300);
  });
});

// ============================================================
// validateRegex
// ============================================================
describe("validateRegex", () => {
  it("returns null for valid regex", () => {
    expect(validateRegex("\\d+", "g")).toBeNull();
    expect(validateRegex("^[a-z]+$", "im")).toBeNull();
  });

  it("returns error message for invalid regex", () => {
    const err = validateRegex("[invalid", "");
    expect(err).not.toBeNull();
    expect(typeof err).toBe("string");
  });

  it("returns error for invalid flags", () => {
    const err = validateRegex("abc", "xyz");
    expect(err).not.toBeNull();
  });
});

// ============================================================
// 预设规则实际效果验证
// ============================================================
describe("preset rules produce expected transforms", () => {
  it("p1: 去除空行", () => {
    const { result } = applyRegex("a\n\nb\n\n\nc", PRESET_RULES[0].pattern, PRESET_RULES[0].replacement, PRESET_RULES[0].flags);
    expect(result).toBe("a\nb\nc");
  });

  it("p3: 合并连续空格", () => {
    const { result } = applyRegex("a    b   c", PRESET_RULES[2].pattern, PRESET_RULES[2].replacement, PRESET_RULES[2].flags);
    expect(result).toBe("a b c");
  });

  it("p6: 手机号脱敏", () => {
    const { result } = applyRegex("13812345678", PRESET_RULES[5].pattern, PRESET_RULES[5].replacement, PRESET_RULES[5].flags);
    expect(result).toBe("138****5678");
  });

  it("p7: 身份证脱敏", () => {
    const { result } = applyRegex("110101199001011234", PRESET_RULES[6].pattern, PRESET_RULES[6].replacement, PRESET_RULES[6].flags);
    expect(result).toBe("1101**********1234");
  });

  it("p8: 去 HTML 标签", () => {
    const { result } = applyRegex("<p>hello</p><br/>", PRESET_RULES[7].pattern, PRESET_RULES[7].replacement, PRESET_RULES[7].flags);
    expect(result).toBe("hello");
  });
});
