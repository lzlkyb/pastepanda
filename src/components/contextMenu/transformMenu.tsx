/**
 * 「粘贴并变换」子菜单的内容。
 *
 * 每条都带变换 id（TransformEntry.t）—— 有了它才能和"类型主操作"按 id 去重，
 * 而不是靠人记住"这一项在上面已经出现过了"。
 */

import type { ReactNode } from "react";
import { isCodeLike } from "@/lib/contentTypes";
import type { MenuItem } from "./menuModel";
import styles from "../ContextMenu.module.css";

/** 一条快捷变换的定义 */
export interface TransformEntry {
  t: string;
  icon: ReactNode;
  label: string;
}

/** 按类型/子类型列出该内容的快捷变换（通用变换已迁入注册表，由「更多变换…」进枢纽） */
export function transformEntries(itemType?: string, subType?: string): TransformEntry[] {
  /** 纯文字图标 */
  const em = (s: string): ReactNode => <span style={{ fontSize: 12 }}>{s}</span>;
  /** 色值图标（带底色的字母块） */
  const swatch = (ch: string, bg: string, color: string): ReactNode => (
    <span className={styles.ctxTextIcon} style={{ background: bg, color }}>{ch}</span>
  );
  const mdLink: TransformEntry = { t: "md_link", icon: em("🔗"), label: "粘贴为 Markdown 链接" };
  const codeBlock: TransformEntry = { t: "code_block", icon: em(`</>`), label: "粘贴为代码块" };

  if (itemType === "image") {
    return [
      { t: "md_image", icon: em("🖼"), label: "粘贴为 Markdown 图片" },
      { t: "img_base64", icon: em("📋"), label: "粘贴为 Base64" },
    ];
  }
  if (itemType === "file") {
    return [
      { t: "file_name", icon: em("📄"), label: "粘贴为文件名" },
      { t: "file_dir", icon: em("📁"), label: "粘贴为目录路径" },
      { t: "file_bslash", icon: em("\\"), label: "粘贴为反斜杠路径" },
      { t: "file_fslash", icon: em("/"), label: "粘贴为正斜杠路径" },
      { t: "file_list", icon: em("📋"), label: "粘贴为文件列表" },
    ];
  }
  if (itemType !== "text") return [];

  // 以下为 text 的各子类型
  if (subType === "link") {
    return [mdLink, { t: "plain_url", icon: em("🔗"), label: "粘贴为纯链接文本" }];
  }
  if (subType === "email") {
    return [{ t: "mailto", icon: em("📧"), label: "粘贴为 mailto 链接" }];
  }
  if (isCodeLike(subType)) {
    return [codeBlock, { t: "single_line", icon: em("≡"), label: "粘贴为单行" }];
  }
  if (subType === "phone") {
    return [
      { t: "tel", icon: em("📞"), label: "粘贴为 tel 链接" },
      { t: "phone_cn", icon: em("+"), label: "粘贴为 +86 格式" },
    ];
  }
  if (subType === "color") {
    return [
      { t: "color_hex", icon: swatch("#", "rgba(255,87,51,.15)", "#FF5733"), label: "复制为 HEX" },
      { t: "color_rgb", icon: swatch("R", "rgba(59,130,246,.15)", "#3B82F6"), label: "复制为 RGB" },
      { t: "color_hsl", icon: swatch("H", "rgba(16,185,129,.15)", "#10B981"), label: "复制为 HSL" },
    ];
  }
  if (subType === "file_path") {
    return [
      { t: "path_bslash", icon: em("\\"), label: "粘贴为反斜杠路径" },
      { t: "path_fslash", icon: em("/"), label: "粘贴为正斜杠路径" },
      { t: "path_name", icon: em("📄"), label: "粘贴为文件名" },
    ];
  }
  if (subType === "markdown") {
    return [codeBlock, mdLink];
  }
  // 普通文本：也有 Markdown 链接
  return [mdLink];
}

/**
 * 生成「粘贴并变换」子菜单。
 *
 * skipTransform：已被"类型主操作"占用的那个变换 id。同一个动作不该在菜单里出现两次 ——
 * 以前图片的「粘贴为 Markdown 图片」、颜色的「复制为 HEX」既是置顶主操作、又在这个
 * 子菜单里重复出现一遍，而 getTypeTools 那边明明是按 primaryKey 去重的，同一份代码两套规矩。
 */
export function buildTransformMenu(
  onTransform: (t: string) => void,
  itemType?: string,
  subType?: string,
  skipTransform?: string,
): MenuItem[] {
  return transformEntries(itemType, subType)
    .filter((e) => e.t !== skipTransform)
    .map((e) => ({ icon: e.icon, label: e.label, onClick: () => onTransform(e.t) }));
}
