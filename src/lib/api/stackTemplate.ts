/**
 * 粘贴栈常用模板 API（P4）
 */
import { invoke } from "@tauri-apps/api/core";
import type { HistoryItem } from "@/stores/appStore";

export interface StackTemplateItem {
  itemType: string;
  text: string;
  content: string;
}

export interface StackTemplate {
  id: string;
  name: string;
  items: StackTemplateItem[];
  createdAt: string;
  usedAt: string | null;
}

/** 栈条目 → 模板条目快照（存独立拷贝，不是引用） */
export function stackItemsToTemplateItems(items: HistoryItem[]): StackTemplateItem[] {
  return items.map((it) => ({ itemType: it.type, text: it.text, content: it.content }));
}

export async function listStackTemplates(): Promise<StackTemplate[]> {
  return invoke<StackTemplate[]>("stack_template_list");
}

export async function saveStackTemplate(name: string, items: StackTemplateItem[]): Promise<string> {
  return invoke<string>("stack_template_save", { name, items });
}

export async function deleteStackTemplate(id: string): Promise<void> {
  await invoke("stack_template_delete", { id });
}

export async function touchStackTemplate(id: string): Promise<void> {
  await invoke("stack_template_touch", { id });
}
