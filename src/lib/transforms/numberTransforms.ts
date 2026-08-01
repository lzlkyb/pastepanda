/**
 * transforms/numberTransforms.ts — 数值工具箱变换（注册到枢纽）。
 *
 * 复用 numberToolbox.ts 的纯函数，提供：
 * - 进制转换（十进制 → HEX / OCT / BIN）
 * - 字节换算（数字 → 最佳单位 + 明细）
 * - 千分位格式化
 *
 * detect 条件：文本含数值 token（parseLeadingNumber 命中）。
 */

import {
  parseLeadingNumber,
  baseInfo,
  bytesInfo,
  formatGrouped,
  timestampInfo,
  tzLabel,
} from "@/lib/numberToolbox";
import type { Transform, TransformContext, TransformResult } from "./types";

function ok(output: string): TransformResult {
  return { ok: true, output };
}

function fail(message: string): TransformResult {
  return { ok: false, message };
}

/** 检测：文本含数值 */
function detectNumber(ctx: TransformContext): number {
  // 利用预分析特征中的时间戳判断排除（时间戳有专门变换）
  if (ctx.features?.timestamp?.isTimestamp) return 0;
  const parsed = parseLeadingNumber(ctx.text);
  if (!parsed) return 0;
  // 纯数字文本更相关
  const isPureNumber = /^\s*-?[\d,]+(\.\d+)?\s*$/.test(ctx.text);
  return isPureNumber ? 0.7 : 0.4;
}

// ============ 进制转换 ============

const baseConvert: Transform = {
  id: "number_base",
  label: "进制转换",
  description: "十进制 → HEX / OCT / BIN",
  icon: "hash",
  group: "text",
  detect: detectNumber,
  run: (t) => {
    const parsed = parseLeadingNumber(t);
    if (!parsed) return fail("未找到数值");
    const info = baseInfo(parsed.value);
    if (!info) return fail("数值超出安全整数范围，无法转换进制");
    const lines = [
      `DEC: ${parsed.value}`,
      `HEX: ${info.hex}`,
      `OCT: ${info.oct}`,
      `BIN: ${info.bin}`,
    ];
    return ok(lines.join("\n"));
  },
};

// ============ 字节换算 ============

const bytesConvert: Transform = {
  id: "number_bytes",
  label: "字节换算",
  description: "将数字解读为字节数，换算为 KB/MB/GB",
  icon: "database",
  group: "text",
  detect: (ctx) => {
    if (ctx.features?.timestamp?.isTimestamp) return 0;
    const parsed = parseLeadingNumber(ctx.text);
    if (!parsed || !parsed.isInteger || parsed.value < 0) return 0;
    // 只对较大的数有意义（< 1024 不显示）
    return parsed.value >= 1024 ? 0.6 : 0;
  },
  run: (t) => {
    const parsed = parseLeadingNumber(t);
    if (!parsed) return fail("未找到数值");
    const info = bytesInfo(parsed.value);
    if (!info) return fail("无法换算（需非负整数）");
    const lines = [`最佳: ${info.best}`];
    if (info.detail) lines.push(`明细: ${info.detail}`);
    return ok(lines.join("\n"));
  },
};

// ============ 千分位 ============

const groupNumber: Transform = {
  id: "number_group",
  label: "千分位",
  description: "为数字添加千分位逗号",
  icon: "code",
  group: "text",
  detect: detectNumber,
  run: (t) => {
    const parsed = parseLeadingNumber(t);
    if (!parsed) return fail("未找到数值");
    return ok(formatGrouped(parsed.value));
  },
};

// ============ 时间戳解读（增强版，含进制） ============

const numberTimestamp: Transform = {
  id: "number_timestamp",
  label: "时间戳解读",
  description: "将数字解读为 Unix 时间戳（含本地时间）",
  icon: "clock",
  group: "text",
  detect: (ctx) => {
    // 优先读预分析特征
    if (ctx.features?.timestamp) return ctx.features.timestamp.isTimestamp ? 0.88 : 0;
    const parsed = parseLeadingNumber(ctx.text);
    if (!parsed || !parsed.isInteger) return 0;
    return timestampInfo(parsed.value) ? 0.88 : 0;
  },
  run: (t) => {
    const parsed = parseLeadingNumber(t);
    if (!parsed) return fail("未找到数值");
    const info = timestampInfo(parsed.value);
    if (!info) return fail("不在合理时间戳范围（2001~2100）");
    const lines = [
      `单位: ${info.unit === "s" ? "秒" : "毫秒"}`,
      `本地: ${info.local} (${tzLabel()})`,
      `UTC:  ${info.iso}`,
      `毫秒: ${info.ms}`,
    ];
    return ok(lines.join("\n"));
  },
};

export const numberTransforms: Transform[] = [
  baseConvert,
  bytesConvert,
  groupNumber,
  numberTimestamp,
];
