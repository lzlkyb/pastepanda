/**
 * transforms/configConverts.ts — 配置格式互转变换（properties ↔ YAML ↔ JSON）。
 *
 * 通过 Tauri invoke 调用 Rust 侧 convert_config 命令完成实际转换。
 * detect 为同步（复用分类引擎 contentType），run 为异步（调 Rust）。
 * TransformHub 需对 run 返回 Promise 的情况做 await 处理。
 */

import type { Transform, TransformContext, TransformResult } from "./types";

/** 调用 Rust 侧转换命令 */
async function invokeConvert(text: string, from: string, to: string): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("convert_config", { text, from, to });
}

/** 检测配置子格式（properties / yaml / json） */
async function detectSubFormat(text: string): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("detect_config_format", { text });
}

/** 共享的 detect 逻辑：内容类型为 config 时高分命中 */
function detectConfig(ctx: TransformContext): number {
  if (ctx.contentType === "config") return 0.9;
  // 回退：文本看起来像 key=value 或 key: value
  const lines = ctx.text.trim().split("\n").slice(0, 10);
  const kvCount = lines.filter(
    (l) => /^[^#\s][^=:]*[=:]/.test(l.trim())
  ).length;
  if (kvCount >= 2) return 0.5;
  return 0;
}

/** 构造异步 run */
function makeAsyncRun(toFormat: string) {
  return async (text: string): Promise<TransformResult> => {
    try {
      const from = await detectSubFormat(text);
      if (from === toFormat) {
        return { ok: true, output: text, message: "已是目标格式" };
      }
      const output = await invokeConvert(text, from, toFormat);
      return { ok: true, output };
    } catch (e) {
      return { ok: false, message: `转换失败: ${e}` };
    }
  };
}

export const configToYamlTransform: Transform = {
  id: "config_to_yaml",
  label: "转为 YAML",
  description: "将 properties / JSON 配置转为 YAML 格式",
  icon: "file-code",
  group: "text",
  detect: detectConfig,
  run: makeAsyncRun("yaml"),
};

export const configToJsonTransform: Transform = {
  id: "config_to_json",
  label: "转为 JSON",
  description: "将 properties / YAML 配置转为 JSON 格式",
  icon: "braces",
  group: "json",
  detect: detectConfig,
  run: makeAsyncRun("json"),
};

export const configToPropertiesTransform: Transform = {
  id: "config_to_properties",
  label: "转为 Properties",
  description: "将 YAML / JSON 配置转为 Java properties 格式",
  icon: "settings",
  group: "text",
  detect: detectConfig,
  run: makeAsyncRun("properties"),
};

export const configConvertTransforms = [
  configToYamlTransform,
  configToJsonTransform,
  configToPropertiesTransform,
];
