/**
 * regexRules.ts — 正则替换规则数据层
 * 预设规则 + 自定义规则 CRUD（SQLite 持久化 + 内存缓存同步读取）+ ReDoS 防护
 *
 * 架构：
 *  - 读操作（getAllRules / getEnabledRules）从内存缓存同步返回，保持所有调用方无需改动
 *  - 写操作（add/update/delete/toggle）同步更新缓存 + 异步持久化到 SQLite
 *  - 首次加载时自动从 localStorage 迁移旧数据到 SQLite
 */
import { invoke } from "@tauri-apps/api/core";
import { logger } from "@/lib/logger";

export interface RegexRule {
  id: string;
  name: string;
  pattern: string;
  replacement: string;
  flags: string;
  enabled: boolean;
  preset: boolean;
  sort_order?: number;
}

const STORAGE_KEY = "pp_regex_rules";
const PRESET_STATE_KEY = STORAGE_KEY + "_preset_state";

/** 预设规则（不可删除，可开关） */
export const PRESET_RULES: RegexRule[] = [
  { id: "p1", name: "去除空行", pattern: "^\\s*$\\n", replacement: "", flags: "gm", enabled: true, preset: true, sort_order: 0 },
  { id: "p2", name: "去除首尾空格", pattern: "^\\s+|\\s+$", replacement: "", flags: "gm", enabled: true, preset: true, sort_order: 1 },
  { id: "p3", name: "合并连续空格", pattern: " {2,}", replacement: " ", flags: "g", enabled: true, preset: true, sort_order: 2 },
  { id: "p4", name: "移除行号", pattern: "^\\s*\\d+[\\.)\\]]\\s*", replacement: "", flags: "gm", enabled: true, preset: true, sort_order: 3 },
  { id: "p5", name: "URL 解码", pattern: "%([0-9A-Fa-f]{2})", replacement: "__URL_DECODE__", flags: "g", enabled: true, preset: true, sort_order: 4 },
  { id: "p6", name: "手机号脱敏", pattern: "(\\d{3})\\d{4}(\\d{4})", replacement: "$1****$2", flags: "g", enabled: true, preset: true, sort_order: 5 },
  { id: "p7", name: "身份证脱敏", pattern: "(\\d{4})\\d{10}(\\d{4})", replacement: "$1**********$2", flags: "g", enabled: true, preset: true, sort_order: 6 },
  { id: "p8", name: "去 HTML 标签", pattern: "<[^>]+>", replacement: "", flags: "g", enabled: true, preset: true, sort_order: 7 },
];

// ===== 内存缓存 =====

let _cache: RegexRule[] | null = null;
let _initialized = false;

/** 重置缓存（仅供测试使用） */
export function _resetCache(): void {
  _cache = null;
  _initialized = false;
  notifyRulesChanged();
}

// ===== 变更通知 =====

/** 规则版本号：每次写入自增。
 *
 *  为什么需要它：_cache 是模块级可变数组、写入是原地改的，而读取方
 *  （卡片右键菜单的「正则替换」子菜单）把 getEnabledRules() 的结果放进了 useMemo。
 *  以前写入不通知任何人，于是在「管理正则规则…」里加/删/启停规则之后，
 *  右键菜单还是旧的一份，要等别的原因触发卡片重渲染才刷新 —— 用户会以为没保存上。 */
let _version = 0;
const _subscribers = new Set<() => void>();

/** 「已启用规则」的派生缓存。
 *
 *  必须返回**稳定引用**：调用方（卡片）用 useSyncExternalStore 订阅它，
 *  每次调用都造新数组的话 React 会判定快照一直在变而无限重渲染
 *  （"The result of getSnapshot should be cached"）。由 notifyRulesChanged 统一失效。 */
let _enabledCache: RegexRule[] | null = null;

/** 当前规则版本号。配合 subscribeRules 供 useSyncExternalStore 使用。 */
export function getRulesVersion(): number {
  return _version;
}

/** 订阅规则变更，返回退订函数。 */
export function subscribeRules(fn: () => void): () => void {
  _subscribers.add(fn);
  return () => {
    _subscribers.delete(fn);
  };
}

/** 自增版本、失效派生缓存并通知订阅者。单个订阅者抛错不能拖垮其余订阅者。 */
function notifyRulesChanged(): void {
  _version++;
  _enabledCache = null;
  _subscribers.forEach((fn) => {
    try {
      fn();
    } catch (e) {
      logger.warn("正则规则变更通知失败", e);
    }
  });
}

/** 构建默认规则列表（预设 + 空自定义） */
function buildDefaults(): RegexRule[] {
  return PRESET_RULES.map((r, i) => ({ ...r, sort_order: i }));
}

/**
 * 改完 _cache 之后的统一提交：落盘 + 通知订阅者。
 *
 * ⚠️ 任何改动 _cache 的地方，改完只准调这一个函数。少调其中一步（比如只落盘不通知）
 * 界面就会停在旧规则上，而这种不一致不会有任何报错 —— 上一次的缺陷正是这么来的。
 */
function commitRules(): void {
  if (!_cache) return;
  invoke("save_regex_rules", { rules: _cache }).catch((e) => {
    logger.warn("正则规则持久化失败", e);
  });
  notifyRulesChanged();
}

/**
 * 初始化正则规则：从 SQLite 加载，首次运行时自动从 localStorage 迁移。
 * 应在 App 启动时调用一次。
 */
export async function initRegexRules(): Promise<void> {
  if (_initialized) return;

  try {
    const dbRules = await invoke<RegexRule[]>("get_regex_rules");

    if (dbRules.length > 0) {
      // SQLite 有数据，直接使用
      _cache = dbRules;
    } else {
      // SQLite 为空 → 尝试从 localStorage 迁移
      _cache = migrateFromLocalStorage();
      if (_cache.length > 0) {
        // 迁移成功，写入 SQLite
        await invoke("save_regex_rules", { rules: _cache });
        // 清理 localStorage
        try {
          localStorage.removeItem(STORAGE_KEY);
          localStorage.removeItem(PRESET_STATE_KEY);
        } catch { /* ignore */ }
        logger.info("正则规则已从 localStorage 迁移至 SQLite");
      } else {
        // 全新安装，使用预设默认值
        _cache = buildDefaults();
        await invoke("save_regex_rules", { rules: _cache });
      }
    }
  } catch (e) {
    logger.warn("从 SQLite 加载正则规则失败，回退到默认值", e);
    _cache = buildDefaults();
  }

  _initialized = true;
  // 加载完也要通知：在 init 完成之前渲染的界面拿到的是 buildDefaults() 的默认值
  // （getAllRules 在 _cache 为空时会回退到它），不通知就会一直停在默认规则上。
  notifyRulesChanged();
}

/** 从 localStorage 迁移旧数据 */
function migrateFromLocalStorage(): RegexRule[] {
  // 读取自定义规则
  let custom: RegexRule[] = [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) custom = JSON.parse(raw) as RegexRule[];
  } catch { /* ignore */ }

  // 读取预设规则开关状态
  let presetState: Record<string, boolean> = {};
  try {
    const raw = localStorage.getItem(PRESET_STATE_KEY);
    if (raw) presetState = JSON.parse(raw);
  } catch { /* ignore */ }

  // 如果没有旧数据，返回空
  if (custom.length === 0 && Object.keys(presetState).length === 0) {
    return [];
  }

  // 合并预设（含开关状态）+ 自定义
  const presets = PRESET_RULES.map((r, i) => ({
    ...r,
    enabled: presetState[r.id] !== undefined ? presetState[r.id] : r.enabled,
    sort_order: i,
  }));

  const customs = custom.map((r, i) => ({
    ...r,
    preset: false,
    sort_order: PRESET_RULES.length + i,
  }));

  return [...presets, ...customs];
}

// ===== 同步读取 API（从缓存） =====

/** 获取所有规则（预设 + 自定义） */
export function getAllRules(): RegexRule[] {
  return _cache ? [..._cache] : buildDefaults();
}

/** 获取已启用的规则（用于菜单展示）。
 *  返回的是共享只读快照（引用稳定，见 _enabledCache），调用方不要就地修改。 */
export function getEnabledRules(): RegexRule[] {
  if (!_enabledCache) _enabledCache = getAllRules().filter((r) => r.enabled);
  return _enabledCache;
}

// ===== 写入 API（同步更新缓存 + 异步持久化） =====

/** 切换预设规则启用状态 */
export function togglePresetRule(id: string): void {
  if (!_cache) return;
  const idx = _cache.findIndex((r) => r.id === id);
  if (idx >= 0) {
    _cache[idx] = { ..._cache[idx], enabled: !_cache[idx].enabled };
    commitRules();
  }
}

/** 添加自定义规则 */
export function addCustomRule(rule: Omit<RegexRule, "id" | "preset">): RegexRule {
  const newRule: RegexRule = {
    ...rule,
    id: `c_${Date.now()}`,
    preset: false,
    sort_order: (_cache?.length ?? PRESET_RULES.length),
  };

  if (_cache) {
    _cache.push(newRule);
    commitRules();
  }
  return newRule;
}

/** 更新自定义规则 */
export function updateCustomRule(id: string, patch: Partial<Omit<RegexRule, "id" | "preset">>): void {
  if (!_cache) return;
  const idx = _cache.findIndex((r) => r.id === id);
  if (idx >= 0) {
    _cache[idx] = { ..._cache[idx], ...patch };
    commitRules();
  }
}

/** 删除自定义规则 */
export function deleteCustomRule(id: string): void {
  if (!_cache) return;
  _cache = _cache.filter((r) => r.id !== id);
  commitRules();
}

/** 切换自定义规则启用状态 */
export function toggleCustomRule(id: string): void {
  if (!_cache) return;
  const idx = _cache.findIndex((r) => r.id === id);
  if (idx >= 0) {
    _cache[idx] = { ..._cache[idx], enabled: !_cache[idx].enabled };
    commitRules();
  }
}

// ===== 纯逻辑函数（无状态，保持不变） =====

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

// ===== 向后兼容导出（已弃用，供迁移期使用） =====

/** @deprecated 使用 initRegexRules + getAllRules 替代 */
export function loadCustomRules(): RegexRule[] {
  return getAllRules().filter((r) => !r.preset);
}

/** @deprecated 使用 addCustomRule / updateCustomRule 替代 */
export function saveCustomRules(rules: RegexRule[]): void {
  // 合并预设 + 传入的自定义规则
  if (!_cache) return;
  const presets = _cache.filter((r) => r.preset);
  _cache = [...presets, ...rules.map((r, i) => ({ ...r, preset: false, sort_order: presets.length + i }))];
  commitRules();
}
