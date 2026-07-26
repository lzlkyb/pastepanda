/**
 * transforms/registry.ts — 变换注册表（纯逻辑，无副作用依赖）。
 *
 * 各变换模块在 index.ts 中调用 registerTransform() 完成注册；
 * UI 通过 applicableTransforms(ctx) 拿到"当前内容适用的变换"并按匹配度排序。
 */

import type { Transform, TransformContext } from "./types";

const registry = new Map<string, Transform>();

/** 注册一个变换（重复 id 会覆盖，便于热替换/测试） */
export function registerTransform(t: Transform): void {
  registry.set(t.id, t);
}

/** 按 id 取变换 */
export function getTransform(id: string): Transform | undefined {
  return registry.get(id);
}

/** 列出所有已注册变换（注册顺序） */
export function listTransforms(): Transform[] {
  return [...registry.values()];
}

/** 命中项：变换 + 匹配度 */
export interface ScoredTransform {
  transform: Transform;
  score: number;
}

/**
 * 返回所有命中的变换（score > 0），按匹配度降序。
 * 这是变换枢纽 / 右键「变换为…」/ 全屏按钮的统一数据源。
 */
export function applicableTransforms(ctx: TransformContext): ScoredTransform[] {
  return listTransforms()
    .map((transform) => ({ transform, score: transform.detect(ctx) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** 测试用：清空注册表 */
export function __clearRegistryForTest(): void {
  registry.clear();
}
