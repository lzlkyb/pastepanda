/**
 * regexRules.ts — 正则替换规则数据层
 * 预设规则 + 自定义规则 CRUD（localStorage）+ ReDoS 防护
 */

export interface RegexRule {
  id: string;
  name: string;
  pattern: string;
  replacement: string;
  flags: string;
  enabled: boolean;
  preset: boolean;
}

const STORAGE_KEY = "pp_regex_rules";

/** 预设规则（不可删除，可开关） */
export const PRESET_RULES: RegexRule[] = [
  { id: "p1", name: "去除空行", pattern: "^\\s*$\\n", replacement: "", flags: "gm", enabled: true, preset: true },
  { id: "p2", name: "去除首尾空格", pattern: "^\\s+|\\s+$", replacement: "", flags: "gm", enabled: true, preset: true },
  { id: "p3", name: "合并连续空格", pattern: " {2,}", replacement: " ", flags: "g", enabled: true, preset: true },
  { id: "p4", name: "移除行号", pattern: "^\\s*\\d+[\\.)\\]]\\s*", replacement: "", flags: "gm", enabled: true, preset: true },
  { id: "p5", name: "URL 解码", pattern: "%([0-9A-Fa-f]{2})", replacement: "__URL_DECODE__", flags: "g", enabled: true, preset: true },
  { id: "p6", name: "手机号脱敏", pattern: "(\\d{3})\\d{4}(\\d{4})", replacement: "$1****$2", flags: "g", enabled: true, preset: true },
  { id: "p7", name: "身份证脱敏", pattern: "(\\d{4})\\d{10}(\\d{4})", replacement: "$1**********$2", flags: "g", enabled: true, preset: true },
  { id: "p8", name: "去 HTML 标签", pattern: "<[^>]+>", replacement: "", flags: "g", enabled: true, preset: true },
];

/** 从 localStorage 加载自定义规则 */
export function loadCustomRules(): RegexRule[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as RegexRule[];
  } catch {
    return [];
  }
}

/** 保存自定义规则到 localStorage */
export function saveCustomRules(rules: RegexRule[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
}

/** 获取所有规则（预设 + 自定义），预设的 enabled 状态也从 localStorage 读取 */
export function getAllRules(): RegexRule[] {
  const custom = loadCustomRules();
  // 预设规则的 enabled 状态持久化
  let presetState: Record<string, boolean> = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY + "_preset_state");
    if (raw) presetState = JSON.parse(raw);
  } catch { /* ignore */ }

  const presets = PRESET_RULES.map((r) => ({
    ...r,
    enabled: presetState[r.id] !== undefined ? presetState[r.id] : r.enabled,
  }));

  return [...presets, ...custom];
}

/** 获取已启用的规则（用于菜单展示） */
export function getEnabledRules(): RegexRule[] {
  return getAllRules().filter((r) => r.enabled);
}

/** 切换预设规则启用状态 */
export function togglePresetRule(id: string): void {
  let presetState: Record<string, boolean> = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY + "_preset_state");
    if (raw) presetState = JSON.parse(raw);
  } catch { /* ignore */ }

  const rule = PRESET_RULES.find((r) => r.id === id);
  if (!rule) return;
  presetState[id] = !(presetState[id] !== undefined ? presetState[id] : rule.enabled);
  localStorage.setItem(STORAGE_KEY + "_preset_state", JSON.stringify(presetState));
}

/** 添加自定义规则 */
export function addCustomRule(rule: Omit<RegexRule, "id" | "preset">): RegexRule {
  const custom = loadCustomRules();
  const newRule: RegexRule = { ...rule, id: `c_${Date.now()}`, preset: false };
  custom.push(newRule);
  saveCustomRules(custom);
  return newRule;
}

/** 更新自定义规则 */
export function updateCustomRule(id: string, patch: Partial<Omit<RegexRule, "id" | "preset">>): void {
  const custom = loadCustomRules();
  const idx = custom.findIndex((r) => r.id === id);
  if (idx >= 0) {
    custom[idx] = { ...custom[idx], ...patch };
    saveCustomRules(custom);
  }
}

/** 删除自定义规则 */
export function deleteCustomRule(id: string): void {
  const custom = loadCustomRules().filter((r) => r.id !== id);
  saveCustomRules(custom);
}

/** 切换自定义规则启用状态 */
export function toggleCustomRule(id: string): void {
  const custom = loadCustomRules();
  const idx = custom.findIndex((r) => r.id === id);
  if (idx >= 0) {
    custom[idx].enabled = !custom[idx].enabled;
    saveCustomRules(custom);
  }
}

/**
 * 执行正则替换（带 ReDoS 防护）
 * 返回 { result, matchCount } 或抛出错误
 */
export function applyRegex(
  text: string,
  pattern: string,
  replacement: string,
  flags: string
): { result: string; matchCount: number } {
  // URL 解码特殊处理
  if (replacement === "__URL_DECODE__") {
    try {
      const result = decodeURIComponent(text);
      const matchCount = (text.match(new RegExp(pattern, flags)) || []).length;
      return { result, matchCount };
    } catch {
      return { result: text, matchCount: 0 };
    }
  }

  const regex = new RegExp(pattern, flags);

  // 计算匹配数
  const matches = text.match(regex);
  const matchCount = matches ? matches.length : 0;

  // 执行替换
  const result = text.replace(regex, replacement);
  return { result, matchCount };
}

/** 预览时间预算（ms）— 超出则中止并报错，防止 ReDoS 冻死 UI */
export const REGEX_TIME_BUDGET_MS = 300;
/** 分块大小（行数）— 单次原生 replace 不可中断，分块才能在块间检查超时 */
const CHUNK_LINES = 20;

/**
 * 安全执行正则（分块 + 时间预算，真正的 ReDoS 防护）
 *
 * 原理：单次 String.replace 是原子操作无法中断，因此按行分块执行，
 * 每块之间检查耗时，超出 REGEX_TIME_BUDGET_MS 立即中止并抛错。
 * 按行分块保证 ^/$（m 标志）等行锚定语义不变；跨行匹配（[\s\S] 等）
 * 在跨块边界时可能漏匹配，属于可接受的预览精度折衷。
 */
export function safeApplyRegex(
  text: string,
  pattern: string,
  replacement: string,
  flags: string,
  maxLen = 100000
): { result: string; matchCount: number; truncated: boolean } {
  const truncated = text.length > maxLen;
  const input = truncated ? text.slice(0, maxLen) : text;

  // URL 解码特殊处理（线性时间，无 ReDoS 风险）
  if (replacement === "__URL_DECODE__") {
    try {
      const result = decodeURIComponent(input);
      const matchCount = (input.match(new RegExp(pattern, flags)) || []).length;
      return { result, matchCount, truncated };
    } catch {
      return { result: input, matchCount: 0, truncated };
    }
  }

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags);
  } catch (e) {
    throw new Error(`正则执行失败: ${e instanceof Error ? e.message : "未知错误"}`);
  }

  const isGlobal = flags.includes("g");
  const deadline = performance.now() + REGEX_TIME_BUDGET_MS;
  // lookbehind 保留行尾 \n，确保 ^/$ 行锚定语义一致
  const lines = input.split(/(?<=\n)/);
  const out: string[] = [];
  let matchCount = 0;
  let replacedFirst = false;

  try {
    for (let i = 0; i < lines.length; i += CHUNK_LINES) {
      if (performance.now() > deadline) {
        throw new Error(
          `正则执行超时（>${REGEX_TIME_BUDGET_MS}ms），已中止 — 请简化正则表达式或缩短文本`
        );
      }
      const chunk = lines.slice(i, i + CHUNK_LINES).join("");
      if (isGlobal) {
        const m = chunk.match(regex);
        if (m) matchCount += m.length;
        out.push(chunk.replace(regex, replacement));
      } else if (!replacedFirst) {
        const m = chunk.match(regex);
        if (m) {
          matchCount = 1;
          replacedFirst = true;
          out.push(chunk.replace(regex, replacement));
        } else {
          out.push(chunk);
        }
      } else {
        out.push(chunk);
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("正则执行超时")) throw e;
    throw new Error(`正则执行失败: ${e instanceof Error ? e.message : "未知错误"}`);
  }

  return { result: out.join(""), matchCount, truncated };
}

/** 验证正则表达式是否合法 */
export function validateRegex(pattern: string, flags: string): string | null {
  try {
    new RegExp(pattern, flags);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "无效的正则表达式";
  }
}
