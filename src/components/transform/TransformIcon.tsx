/**
 * 变换 / AI 动作的图标语义键 → lucide 组件。
 *
 * 这张表原来寄在 `TransformCard.tsx` 里，只有主窗口能用。截图 AI 弹层拿不到它，
 * 于是把后端返回的 **icon 名字符串**直接当图标画进 26px 的格子里：
 * 实测 23 行里 20 行的字符串超出容器（最宽 42px，与标题只留 10px 间距），
 * 英文串尾压在中文标签上 —— 就是「这页 UI 和整体风格不一致」的直接原因。
 * 收口成一处，两个入口不可能再漂移（规则 11.1）。
 *
 * 键必须与后端字面一致：内置动作的 icon 取值见 `src-tauri/src/ai/actions.rs`，
 * 自定义动作由用户填（填不出来就回落 Sparkles，不报错——它不该挡住整个面板）。
 * 覆盖情况由 `transformIcons.test.ts` 守着。
 */

import {
  Braces, CalendarDays, CalendarRange, CaseLower, CaseUpper, Code, Database,
  Eraser, FileText, Folder, GitBranch, GitCommitHorizontal, Globe, Hash,
  Languages, Link as LinkIcon, List, ListCollapse, Mail, Merge, MessageSquare,
  Minus, Palette, PenLine, Phone, Pilcrow, Quote, Regex, RemoveFormatting,
  Reply, Search, Sparkles, Table, Tags, WandSparkles, Workflow, Wrench,
  type LucideIcon,
} from "lucide-react";

/** 图标语义键 → lucide 组件（逻辑层保持纯净，图标在 UI 层映射） */
export const TRANSFORM_ICONS: Record<string, LucideIcon> = {
  // ---- 本地变换 ----
  database: Database,
  table: Table,
  // 后端 ai-key-points 用的是 lucide 的 `list`；`rows` 是本地变换里的旧别名，两个都认
  rows: List,
  list: List,
  "case-upper": CaseUpper,
  "case-lower": CaseLower,
  eraser: Eraser,
  pilcrow: Pilcrow,
  quote: Quote,
  "remove-formatting": RemoveFormatting,
  link: LinkIcon,
  globe: Globe,
  mail: Mail,
  phone: Phone,
  code: Code,
  minus: Minus,
  hash: Hash,
  palette: Palette,
  folder: Folder,
  "file-text": FileText,
  search: Search,
  "list-collapse": ListCollapse,
  // ---- 内置 AI 动作（ai/actions.rs 的 21 个取值全覆盖）----
  languages: Languages,
  "pen-line": PenLine,
  braces: Braces,
  "calendar-days": CalendarDays,
  "calendar-range": CalendarRange,
  "git-branch": GitBranch,
  "git-commit-horizontal": GitCommitHorizontal,
  merge: Merge,
  "message-square": MessageSquare,
  regex: Regex,
  reply: Reply,
  sparkles: Sparkles,
  tags: Tags,
  "wand-sparkles": WandSparkles,
  workflow: Workflow,
  wrench: Wrench,
};

export function TIcon({ name, size = 15 }: { name?: string; size?: number }) {
  const C = (name && TRANSFORM_ICONS[name]) || Sparkles;
  return <C size={size} />;
}
