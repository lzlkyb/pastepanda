/**
 * 云端 AI API —— 配置、密钥、动作执行。
 *
 * **注意：没有读取 API Key 的接口，也不会有。**
 * 后端只提供 set / has / clear，密钥加密后存在独立文件里，前端拿不到明文。
 * 界面上展示“已配置”用 {@link aiHasKey}，想改就重新输入。
 *
 * **密钥按厂商分开存**：所有密钥相关接口都接受可选的 `provider`，
 * 不传就是当前生效的那家。切厂商不需要重输密钥。
 */
import { invoke } from "@tauri-apps/api/core";

/**
 * 接口协议。取值与后端 `Protocol` 的序列化值一一对应（有 Rust 测试盯着）。
 *
 * 两者路径、鉴权头、字段名都不同：
 * - `openai`    → `POST {base}/chat/completions`，`Authorization: Bearer`
 * - `anthropic` → `POST {base}/messages`，`x-api-key` + `anthropic-version`
 */
export type AiProtocol = "openai" | "anthropic";

export interface AiModelSpec {
  id: string;
  /** 给人看的说明，如“便宜快速（推荐）” */
  label: string;
  /**
   * 推理模型：回答前先输出一大段思维链，而思考的 token 照样计费、
   * 也照样占用动作的 token 上限。
   *
   * 只是提示，并不完全（模型可以手填）。真正的保护在后端。
   */
  reasoning: boolean;
}

/**
 * 厂商预设。**整张表的单一数据源在 Rust 侧**（`ai/provider.rs`）。
 *
 * 这里不再写 `AiProviderId` 那样的联合类型：十几家厂商在两边各维护一份，
 * 加一家就得改两处，迟早漂移。前端一律把 id 当普通字符串，选项从这个接口拿。
 */
export interface AiProviderInfo {
  id: string;
  name: string;
  /** 厂商默认地址，不带尾斜杠。空串表示必须用户自填 */
  baseUrl: string;
  models: AiModelSpec[];
  /** 这家支不支持“关掉思考”（由后端派生，前端不另抄一份名单） */
  supportsThinkingOff: boolean;
  /** 申请 API Key 的页面。空串表示没有（自定义/中转） */
  keyUrl: string;
  note: string;
  /** false 表示不需要密钥（目前只有 Ollama） */
  needsKey: boolean;
  /** true 表示模型要自由输入而不是下拉选（火山方舟填的是接入点 ID） */
  modelIsFreeText: boolean;
  modelHint: string;
  /** 每百万 token 粗略单价（美元） */
  priceIn: number;
  priceOut: number;
  protocol: AiProtocol;
  /** 这家是否已存过密钥——下拉里据此标“已配置” */
  hasKey: boolean;
  /** 自定义服务商已存模型（编辑弹窗回填用；内置厂商无此字段） */
  model?: string;
  /** v6.4：true = 用户添加的自定义服务商（可多个，各自独立配置/密钥） */
  custom?: boolean;
  /** v6.9：true = 内置免费额度服务商（签到送 token，走 token 配额计费） */
  builtinFree?: boolean;
}

export interface AiConfig {
  enabled: boolean;
  /** 厂商 id，取值见 {@link aiListProviders} */
  provider: string;
  /** 为空则用厂商默认值 */
  baseUrl: string;
  /** 为空则用厂商默认模型 */
  model: string;
  /** 日预算上限（**人民币**），0 表示不限制 */
  dailyBudgetCny: number;
  timeoutSecs: number;
  /**
   * 向支持的厂商请求“不要思考，直接回答”。**默认开**。
   *
   * 不支持的厂商上无效（不发字段），看 `supportsThinkingOff`。
   */
  thinkingOff: boolean;
  /** 协议覆盖，空串表示用厂商默认 */
  protocol: string;
  /**
   * 把用户**手工**标签名当意图上下文拼进 prompt。**默认开**。
   *
   * 开着时标签名会随内容一起发给服务商（它们常含客户名/项目名/人名），
   * 但也与正文同过一道出网闸。前端不判这个开关，只负责展示与修改；
   * 真正的判断在后端（见 provider.rs 的 tags_as_context）。
   */
  tagsAsContext: boolean;
  /**
   * 把用户画像压成一段描述拼进 system prompt（D1）。**默认开**。
   *
   * 发出去的是纯本地固定文案的组合（不含剪贴板内容、不含自定义动作名），
   * 设置页会把它原样展示出来（`profilePromptPreview`）。
   * 与 `tagsAsContext` 一样：前端不判这个开关，真正的判断在后端（provider.rs）。
   */
  profileAsContext: boolean;
}

export interface AiActionOptionValue {
  value: string;
  label: string;
}

export interface AiActionOptionSpec {
  key: string;
  label: string;
  values: AiActionOptionValue[];
  default: string;
}

export interface AiActionMeta {
  id: string;
  label: string;
  description: string;
  icon: string;
  maxTokens: number;
  options: AiActionOptionSpec[];
  /** 适用的内容类型；空 = 不限 */
  contentTypes: string[];
}

/** 用户自定义的 AI 动作。`id` 为空串表示新建。 */
export interface AiCustomAction {
  id: string;
  name: string;
  description: string;
  icon: string;
  /** 提示词模板，必含 {{内容}} */
  template: string;
  maxTokens: number;
  contentTypes: string[];
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** 编辑器里可选的适用内容类型。单一数据源在后端 */
export interface AiContentTypeOption {
  id: string;
  label: string;
}

/** 按天聚合。后端 `AiUsageDaily` 的镜像。 */
export interface AiUsageDaily {
  /** `YYYY-MM-DD` */
  date: string;
  /** 总条数（含缓存命中与失败） */
  calls: number;
  /** 真实计费的次数：未命中缓存且成功 */
  billableCalls: number;
  cachedCalls: number;
  failedCalls: number;
  promptTokens: number;
  completionTokens: number;
  /** 估算值，不是账单金额 */
  costUsd: number;
}

/** 一次调用的明细。**不含任何内容文本**——表里根本没那个字段。 */
export interface AiUsageLogRow {
  id: number;
  /** `YYYY-MM-DD HH:MM:SS` */
  createdAt: string;
  /** 动作 id；连通性测试为 `connection-test` */
  actionId: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  cached: boolean;
  latencyMs: number;
  ok: boolean;
  error: string | null;
}

export interface AiUsageByAction {
  actionId: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  /** 已按后端汇率换算好——前端不得再乘一次 */
  costCny: number;
}

export interface AiUsageStats {
  days: number;
  /** 按天升序；**缺的天不补 0** */
  daily: AiUsageDaily[];
  /** 按动作，花费降序 */
  byAction: AiUsageByAction[];
  totalCalls: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCostCny: number;
  /** 缓存命中率 0~1。省下的钱直接体现在它上面 */
  cacheHitRate: number;
}

/** 今日用量 + 预算展示字段 */
export interface AiUsage extends AiUsageDaily {
  /** 同上，已按后端汇率换算好 —— 前端不自己乘，免得出第二个汇率 */
  costCny: number;
  /** 当前日预算（人民币），0 表示不限制 */
  budgetCny: number;
  /** 预算内大约还能调用多少次；不限制或本地厂商时为 null */
  remainingCalls: number | null;
}

export interface AiTestResult {
  model: string;
  protocol: AiProtocol;
  latencyMs: number;
  reply: string;
  /** 测通后后端自动把 AI 启用了，界面据此提示，不必再让用户找开关 */
  autoEnabled: boolean;
}

/**
 * `ai_run` 的三态返回。
 *
 * “需要确认”和“超预算”不是错误，是需要界面分支处理的正常结果；
 * 真正的错误（网络 / 鉴权 / 解析）会以 reject 抛出。
 */
export type AiRunResponse =
  | {
      status: "ok";
      content: string;
      model: string;
      /** true 表示命中缓存，本次没有实际调用云端（也就没计费） */
      cached: boolean;
      promptTokens: number;
      completionTokens: number;
      /**
       * 回答撞到 token 上限被截断。内容仍然返回，但界面必须说明，
       * 否则用户会把“断在半句”当成模型水平差。截断的结果不会进缓存。
       */
      truncated: boolean;
    }
  | { status: "needsConfirm"; reason: string }
  | { status: "budgetExceeded"; spentCny: number; budgetCny: number; isQuota?: boolean };

export async function aiGetConfig(): Promise<AiConfig> {
  return invoke<AiConfig>("ai_get_config");
}

export async function aiSetConfig(config: AiConfig): Promise<void> {
  return invoke("ai_set_config", { config });
}

/** 写入密钥（传空串等于清除）。不指定厂商就写给当前选中的那家 */
export async function aiSetKey(key: string, provider?: string): Promise<void> {
  return invoke("ai_set_key", { key, provider });
}

/** 是否已配置可用的密钥。注意后端会真去解密一次，文件存在但解不开也算 false */
export async function aiHasKey(provider?: string): Promise<boolean> {
  return invoke<boolean>("ai_has_key", { provider });
}

export async function aiClearKey(provider?: string): Promise<void> {
  return invoke("ai_clear_key", { provider });
}

export async function aiListProviders(): Promise<AiProviderInfo[]> {
  return invoke<AiProviderInfo[]>("ai_list_providers");
}

// ===== v6.4 AI 面板 v2：per-provider 配置 + 自定义服务商多实例 =====

/** 指定服务商的 模型/地址/协议（切换时回填，不动当前选中） */
export interface ProviderConfigValue {
  baseUrl: string;
  model: string;
  protocol: AiProtocol | "";
}

/** 读取指定服务商已保存的模型/地址/协议 */
export async function aiGetProviderConfig(providerId: string): Promise<ProviderConfigValue> {
  return invoke<ProviderConfigValue>("ai_get_provider_config", { providerId });
}

/** 自定义服务商条目（保存入参） */
export interface CustomProviderInput {
  /** 为空 = 新增（后端生成 id）；非空 = 更新 */
  id?: string;
  name: string;
  baseUrl: string;
  model: string;
  protocol?: AiProtocol | "";
}

/** 新增或更新自定义服务商，返回其 id */
export async function aiSaveCustomProvider(item: CustomProviderInput): Promise<string> {
  return invoke<string>("ai_save_custom_provider", { item });
}

/** 删除自定义服务商（含其密钥文件） */
export async function aiDeleteCustomProvider(id: string): Promise<void> {
  return invoke("ai_delete_custom_provider", { id });
}

/** 内置动作清单。自定义走 {@link aiListCustomActions} */
export async function aiListActions(): Promise<AiActionMeta[]> {
  return invoke<AiActionMeta[]>("ai_list_actions");
}

export async function aiListContentTypes(): Promise<AiContentTypeOption[]> {
  return invoke<AiContentTypeOption[]>("ai_list_content_types");
}

export async function aiListCustomActions(): Promise<AiCustomAction[]> {
  return invoke<AiCustomAction[]>("ai_list_custom_actions");
}

/** 新建或更新，返回最终 id。模板缺 {{内容}} 会在这里被拒 */
export async function aiSaveCustomAction(action: AiCustomAction): Promise<string> {
  return invoke<string>("ai_save_custom_action", { action });
}

export async function aiDeleteCustomAction(id: string): Promise<void> {
  return invoke("ai_delete_custom_action", { id });
}

/** 传进去的 id 顺序就是新顺序 */
export async function aiReorderCustomActions(ids: string[]): Promise<void> {
  return invoke("ai_reorder_custom_actions", { ids });
}

/**
 * 编辑器里的「试跑」：拿**还没保存**的模板真发一次。
 *
 * **会真实计费**，不走缓存。返回与 {@link aiRun} 同一套三态结果。
 */
export async function aiPreviewCustom(
  template: string,
  text: string,
  maxTokens?: number,
  force?: boolean
): Promise<AiRunResponse> {
  return invoke<AiRunResponse>("ai_preview_custom", { template, text, maxTokens, force });
}

export async function aiGetUsage(): Promise<AiUsage> {
  return invoke<AiUsage>("ai_get_usage");
}

/** 最近 N 条调用明细（时间倒序，不含内容） */
export async function aiListUsageLog(limit?: number): Promise<AiUsageLogRow[]> {
  return invoke<AiUsageLogRow[]>("ai_list_usage_log", { limit });
}

/** 最近 N 天的用量统计（默认 7 天） */
export async function aiGetUsageStats(days?: number): Promise<AiUsageStats> {
  return invoke<AiUsageStats>("ai_get_usage_stats", { days });
}

/** 清空明细，返回删掉的条数 */
export async function aiClearUsageLog(): Promise<number> {
  return invoke<number>("ai_clear_usage_log");
}

/** 真实发一次最小请求验证配置可用；**通过后后端会自动启用 AI** */
export async function aiTestConnection(): Promise<AiTestResult> {
  return invoke<AiTestResult>("ai_test_connection");
}

/**
 * 执行一个云端动作。
 *
 * `force` 仅在用户已在敏感内容提示上确认后传 true。
 */
/**
 * 让模型根据内容编一条动作链（B）。
 *
 * `actions` 是**可用动作清单**，只能前端给——链的步骤是前端变换注册表里的 id，
 * 后端不认识 `strip_html` 这些。返回的 `content` 是**模型原始文本**，
 * 必须交给 `parseChainPlan` 解析 + 白名单校验，不能直接相信。
 *
 * 与 {@link aiRun} 同一套三态结果（正常 / 需确认 / 超预算）。
 */
export async function aiPlanChain(
  text: string,
  actions: { id: string; label: string; description: string }[],
  force?: boolean,
): Promise<AiRunResponse> {
  return invoke<AiRunResponse>("ai_plan_chain", { text, actions, force });
}

export async function aiRun(
  actionId: string,
  text: string,
  opts?: Record<string, string>,
  force?: boolean
): Promise<AiRunResponse> {
  return invoke<AiRunResponse>("ai_run", { actionId, text, opts, force });
}
