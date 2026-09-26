/**
 * rcDeviceTags — 设备标签的单一取值口径（2026-09-26 对齐稿①，规则 11.1 收口）。
 *
 * RustDesk TagPainter 的本地对应物：标签是「名字 + 色板键」，行上只画色点、
 * 文字进悬停。色板固定 6 档且**只存键名不存 hex**（V3：颜色必须来自令牌），
 * 渲染统一走 `data-color` 属性 + CSS `[data-color="blue"]` 选择器——
 * 新调用点忘走白名单会被这里的守卫函数挡住，而不是把脏值写进库。
 *
 * 与 Rust 侧 `normalize_tags`（data_store/rc_device.rs）同口径双保险：
 * 前端先清洗保住即时 UI 反馈，后端再清洗挡住绕过 invoke 直写的路径。
 */
import type { RcDeviceTag } from "@/lib/api/rc";

export const TAG_COLOR_KEYS = ["red", "amber", "green", "cyan", "blue", "violet"] as const;
export type TagColorKey = (typeof TAG_COLOR_KEYS)[number];
export const DEFAULT_TAG_COLOR: TagColorKey = "blue";
export const MAX_TAGS_PER_DEVICE = 6;
export const MAX_TAG_NAME_CHARS = 12;

export function isTagColorKey(x: string): x is TagColorKey {
  return (TAG_COLOR_KEYS as readonly string[]).includes(x);
}

/** 色板外的键一律回落 blue——渲染点也只许调这个函数取色。 */
export function tagColorOf(tag: RcDeviceTag): TagColorKey {
  return isTagColorKey(tag.color) ? tag.color : DEFAULT_TAG_COLOR;
}

/** 保存前清洗：trim、丢空、截断、按名去重、上限 6、色板白名单。 */
export function normalizeDeviceTags(tags: RcDeviceTag[]): RcDeviceTag[] {
  const out: RcDeviceTag[] = [];
  for (const t of tags) {
    const name = t.name.trim().slice(0, MAX_TAG_NAME_CHARS);
    if (!name || out.some((x) => x.name === name)) continue;
    out.push({ name, color: tagColorOf(t) });
    if (out.length >= MAX_TAGS_PER_DEVICE) break;
  }
  return out;
}

/** 全部设备上出现过的标签（按名字去重，色取首次出现）——筛选 chip 行的数据源。 */
export function distinctTagsOf(targets: { tags?: RcDeviceTag[] }[]): RcDeviceTag[] {
  const seen = new Map<string, RcDeviceTag>();
  for (const t of targets) {
    for (const tag of t.tags ?? []) {
      if (!seen.has(tag.name)) seen.set(tag.name, { name: tag.name, color: tagColorOf(tag) });
    }
  }
  return [...seen.values()];
}

/** 悬停/详情里的一句话标签汇总；无标签返回空串（不编「无标签」占位）。 */
export function tagSummaryOf(tags?: RcDeviceTag[]): string {
  if (!tags?.length) return "";
  return `标签：${tags.map((t) => t.name).join("、")}`;
}
