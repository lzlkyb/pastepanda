/**
 * 把后端的错误文案映射成“下一步该做什么”。
 *
 * 后端的错误信息本身已经是中文且带原因（见 `ai/client.rs` 的 `AiError`），
 * 这里**不重复那句话**，只补一个可点的动作：用户看到“API Key 无效”时
 * 最想要的是光标直接落回密钥框，而不是自己滚回去找。
 *
 * 匹配用关键词而不是错误码：Tauri 命令层把 `AiError` 转成了字符串，
 * 前端拿不到分类。关键词都有 Rust 侧测试锁着（`test_error_messages_are_chinese_and_actionable`）。
 */

export type AiErrorAction = "focusKey" | "openAdvanced" | "switchProvider" | null;

export interface AiErrorHint {
  action: AiErrorAction;
  /** action 为 null 时不用 */
  actionLabel: string;
  hint: string;
}

/** 厂商被当地网络挡住时推荐切换的目标。与后端 `DEFAULT_PROVIDER` 一致 */
export const FALLBACK_PROVIDER = "deepseek";
export const FALLBACK_PROVIDER_NAME = "DeepSeek";

export function hintForError(message: string): AiErrorHint | null {
  if (message.includes("API Key")) {
    return {
      action: "focusKey",
      actionLabel: "重新输入密钥",
      hint: "常见原因：复制时漏了字符、密钥已在服务商后台被删，或这把 Key 不属于当前服务商。",
    };
  }
  if (message.includes("地区")) {
    return {
      action: "switchProvider",
      actionLabel: `改用 ${FALLBACK_PROVIDER_NAME}`,
      hint: "这家在当前网络下被挡在鉴权之前，密钥对不对都不影响结果。换国内可直连的厂商最省事，或走代理/中转。",
    };
  }
  if (message.includes("协议")) {
    return {
      action: "openAdvanced",
      actionLabel: "打开高级设置",
      hint: "接口地址或协议对不上：OpenAI 兼容走 /chat/completions，Anthropic 走 /messages。地址只填到 /v1 为止。",
    };
  }
  if (message.includes("超时")) {
    return {
      action: "switchProvider",
      actionLabel: `改用 ${FALLBACK_PROVIDER_NAME}`,
      hint: "国内网络直连境外厂商常见超时。也可在高级设置里把超时调长再试。",
    };
  }
  if (message.includes("余额")) {
    return {
      action: null,
      actionLabel: "",
      hint: "密钥本身是好的，去服务商控制台充值或确认免费额度后重试。",
    };
  }
  if (message.includes("频繁")) {
    return {
      action: null,
      actionLabel: "",
      hint: "稍等十几秒再试。免费额度的并发限制通常很低。",
    };
  }
  if (message.includes("未填写")) {
    return {
      action: "openAdvanced",
      actionLabel: "打开高级设置",
      hint: "这家服务商需要你自己填地址或模型名。",
    };
  }
  return null;
}
