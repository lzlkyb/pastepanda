/**
 * 卡片右键菜单的**内容**（有哪些项、什么顺序、按类型显示哪些）。
 *
 * 与容器组件分开：菜单摆什么和菜单怎么弹是两件事，前者是可以纯函数测试的分支逻辑。
 *
 * 分区顺序：① 类型主操作（置顶高亮）② 核心剪贴板 + 粘贴并变换 + 正则替换
 * ③ 类型工具 ④ 更多操作 ⑤ 删除。
 *
 * **主操作不与别处重复**：主操作是从下面几个区块里"提"上来的，所以提上来之后
 * 原处必须去掉 —— 类型工具靠 primaryKey 去重，粘贴并变换靠 primary.transform 去重。
 */

import { Copy, ClipboardPaste, Pin, Trash2, ExternalLink, FileCode, Pencil, Tag, FolderInput, FolderOpen, FileText, Sparkles, Image as ImageIcon, Palette, MoreHorizontal, Regex, NotebookPen, CalendarPlus } from "lucide-react";
import { isCodeLike } from "@/lib/contentTypes";
import type { RegexRule } from "@/lib/regexRules";
import type { MenuItem } from "./menuModel";
import { buildTransformMenu } from "./transformMenu";

export function createCardMenuItems(opts: {
  onCopy: () => void;
  onPaste: () => void;
  onPin: () => void;
  onDelete: () => void;
  /** 图片且有 OCR 文本时：复制识别文字（调用方仅在 getImageOcrFullText 非空时注入） */
  onCopyOcr?: () => void;
  onEdit?: () => void;
  onEditTags?: () => void;
  onMoveToGroup?: () => void;
  onAddSnippet?: () => void;
  onOpenUrl?: () => void;
  /** file_path 卡片：用默认应用打开（后端 open_file_with_system） */
  onOpenFile?: () => void;
  /** file_path 卡片：在资源管理器中显示（后端 open_file_location） */
  onRevealFile?: () => void;
  onPasteTransform?: (transform: string) => void;
  /** 打开变换枢纽：列出当前内容可用的所有变换（SQL IN / INSERT / …） */
  onOpenHub?: () => void;
  onConfirmAutoTags?: () => void;
  onRemoveAutoTags?: () => void;
  onQrCode?: () => void;
  /**
   * 转为笔记 / 编辑已有笔记（知识库 A 阶段 · 规划 §8.1 3️⃣）。
   *
   * 不传 = 菜单里根本不出现这一项。file 卡片就走这条：它的正文只是一个路径，
   * 转成笔记没意义。**先显示再报错是更差的做法**（设计稿 §7）。
   */
  onConvertToNote?: () => void;
  /**
   * 追加到今日速记（B2 #3 / D11）。不传 = 不出现这一项（同 `onConvertToNote` 的口径）。
   *
   * 与「转为笔记」相邻，因为它俩是同一类动作的两个力度：
   * 转为笔记 = 这条值得单独立一篇；追加到速记 = 先丢进今天，回头再说。
   */
  onAppendDaily?: () => void;
  /** 这张卡片已经转过笔记——只影响文案（转为/编辑），幂等逻辑在调用方 */
  hasNote?: boolean;
  pinned?: boolean;
  hasUrl?: boolean;
  hasAutoTags?: boolean;
  canQrCode?: boolean;
  onRegexPreview?: (ruleId: string) => void;
  /** 已启用的正则规则。**由调用方传入**，不在这里读模块缓存 ——
   *  以前这里直接调 getEnabledRules()，是个隐藏的全局读：调用方把结果 memo 起来之后，
   *  规则改了菜单却不会重算（依赖表里没有任何能反映规则变化的东西）。
   *  作为显式入参传进来，"规则变了要重算"就成了依赖表上看得见的事实。 */
  regexRules?: RegexRule[];
  onManageRegexRules?: () => void;
  /** item 基础类型 + 子类型，用于按类型生成不同变换菜单 */
  itemType?: string;
  itemSubType?: string;
}): MenuItem[] {
  const items: MenuItem[] = [];

  // ① 类型主操作（置顶高亮）——按条目类型挑选最具代表性的动作
  const primary = getPrimaryAction(opts);
  if (primary) {
    items.push({ ...primary.item, primary: true });
  }

  // ② 核心剪贴板操作
  items.push(
    { icon: <Copy size={14} />, label: "复制到剪贴板", onClick: opts.onCopy },
    { icon: <ClipboardPaste size={14} />, label: "粘贴到前台", onClick: opts.onPaste },
  );

  // 粘贴变换折叠为子菜单：子类型快捷项 + 「更多变换…」（枢纽兜底）
  if (opts.onPasteTransform) {
    const transformChildren: MenuItem[] = buildTransformMenu(opts.onPasteTransform, opts.itemType, opts.itemSubType, primary?.transform);

    // 「更多变换…」— 打开变换枢纽，长尾通用变换全部收纳于此（仅 text 类型）
    if (opts.onOpenHub && opts.itemType === "text") {
      transformChildren.push({
        icon: <Sparkles size={14} />,
        label: "更多变换…",
        onClick: opts.onOpenHub,
        separator: transformChildren.length > 0,
      });
    }

    if (transformChildren.length > 0) {
      items.push({
        icon: <ClipboardPaste size={14} />,
        label: "粘贴并变换",
        children: transformChildren,
      });
    }
  }

  // 正则替换：独立顶层子菜单（规则列表 + 管理入口）
  if (opts.onRegexPreview && opts.itemType === "text") {
    const regexChildren: MenuItem[] = [];
    for (const rule of opts.regexRules ?? []) {
      regexChildren.push({
        icon: <span style={{ fontSize: 12 }}>{rule.preset ? "🔤" : "🏷"}</span>,
        label: rule.name,
        onClick: () => opts.onRegexPreview!(rule.id),
      });
    }
    if (opts.onManageRegexRules) {
      regexChildren.push({
        icon: <span style={{ fontSize: 12 }}>⚙</span>,
        label: "管理正则规则…",
        onClick: opts.onManageRegexRules,
        separator: regexChildren.length > 0,
      });
    }
    if (regexChildren.length > 0) {
      items.push({ icon: <Regex size={14} />, label: "正则替换", children: regexChildren });
    }
  }

  // ③ 类型工具（次级的类型相关操作，排除已作为主操作的项）
  const tools = getTypeTools(opts, primary?.key ?? null);
  tools.forEach((t, idx) => {
    items.push(idx === 0 ? { ...t, separator: true } : t);
  });

  // ④ 更多操作（标签/分组/置顶/片段库等管理项统一收纳）
  const moreChildren = getMoreChildren(opts);
  if (moreChildren.length > 0) {
    items.push({ icon: <MoreHorizontal size={14} />, label: "更多操作", children: moreChildren, separator: true });
  }

  // ④.5 转为笔记（知识库 A 阶段）——放顶层而不塞进「更多操作」：
  //   它是知识库的主入口，藏进二级子菜单就没人会发现。
  //   文案随已否转过变：幂等路径下点它是去编辑旧那条，写「转为笔记」会让人以为又存了一份。
  if (opts.onConvertToNote) {
    items.push({
      icon: <NotebookPen size={14} />,
      label: opts.hasNote ? "编辑笔记" : "转为笔记",
      onClick: opts.onConvertToNote,
      separator: true,
    });
  }

  // ④.6 追加到今日速记（B2 #3）。紧跟在转笔记后面，不带 separator——
  //   两者是一组（都是「把这条收进知识库」），中间画线会把它们拆成两回事。
  if (opts.onAppendDaily) {
    items.push({
      icon: <CalendarPlus size={14} />,
      label: "追加到今日速记",
      onClick: opts.onAppendDaily,
    });
  }

  // ⑤ 删除
  items.push(
    { icon: <Trash2 size={14} />, label: "删除", onClick: opts.onDelete, danger: true, separator: true },
  );

  return items;
}

type CardMenuOpts = Parameters<typeof createCardMenuItems>[0];

/** 类型主操作：按条目类型挑选最具代表性的动作置顶高亮。
 *  transform 字段用于让「粘贴并变换」子菜单把同一个动作剔掉，避免一个动作出现两次。 */
function getPrimaryAction(opts: CardMenuOpts): { key: string; item: MenuItem; transform?: string } | null {
  const st = opts.itemSubType;
  const t = opts.itemType;

  // 图片：粘贴为 Markdown 图片
  if (t === "image" && opts.onPasteTransform) {
    return { key: "mdImage", transform: "md_image", item: { icon: <ImageIcon size={14} />, label: "粘贴为 Markdown 图片", onClick: () => opts.onPasteTransform!("md_image") } };
  }
  // 文件 / 路径：在资源管理器中显示
  if (opts.onRevealFile) {
    return { key: "reveal", item: { icon: <FolderOpen size={14} />, label: "在资源管理器中显示", onClick: opts.onRevealFile } };
  }
  // 链接：在浏览器中打开
  if (opts.hasUrl && opts.onOpenUrl) {
    return { key: "openUrl", item: { icon: <ExternalLink size={14} />, label: "在浏览器中打开", onClick: opts.onOpenUrl } };
  }
  // JSON：变换枢纽（SQL IN / INSERT / … 的统一入口，置顶高亮）
  if (st === "json" && opts.onOpenHub) {
    return { key: "hub", item: { icon: <Sparkles size={14} />, label: "变换为…", onClick: opts.onOpenHub } };
  }
  // 颜色：复制为 HEX
  if (st === "color" && opts.onPasteTransform) {
    return { key: "colorHex", transform: "color_hex", item: { icon: <Palette size={14} />, label: "复制为 HEX", onClick: () => opts.onPasteTransform!("color_hex") } };
  }
  // 文本（含各子类型）：编辑内容
  if (opts.onEdit) {
    return { key: "edit", item: { icon: <Pencil size={14} />, label: editLabelFor(st), onClick: opts.onEdit } };
  }
  return null;
}

/** 类型工具：次级的类型相关操作（排除已作为主操作的项） */
function getTypeTools(opts: CardMenuOpts, primaryKey: string | null): MenuItem[] {
  const tools: MenuItem[] = [];
  const st = opts.itemSubType;

  // 图片且有 OCR 文本：复制识别文字（首位——图片专属的复制能力，调用方仅在
  // getImageOcrFullText 非空时注入回调；与通用「复制到剪贴板」复制图片区分）
  if (opts.itemType === "image" && opts.onCopyOcr) {
    tools.push({ icon: <FileText size={14} />, label: "复制识别文字", onClick: opts.onCopyOcr });
  }
  // 编辑入口（主操作不是编辑时，作为次级工具）
  if (opts.onEdit && primaryKey !== "edit") {
    tools.push({ icon: <Pencil size={14} />, label: editLabelFor(st), onClick: opts.onEdit });
  }
  // 在浏览器中打开（主操作不是它时）
  if (opts.hasUrl && opts.onOpenUrl && primaryKey !== "openUrl") {
    tools.push({ icon: <ExternalLink size={14} />, label: "在浏览器中打开", onClick: opts.onOpenUrl });
  }
  // 用默认应用打开（路径 / 文件）
  if (opts.onOpenFile) {
    tools.push({ icon: <FileText size={14} />, label: "用默认应用打开", onClick: opts.onOpenFile });
  }
  // 在资源管理器中显示（主操作不是它时）
  if (opts.onRevealFile && primaryKey !== "reveal") {
    tools.push({ icon: <FolderOpen size={14} />, label: "在资源管理器中显示", onClick: opts.onRevealFile });
  }
  // 二维码（沿用现有 canQrCode 规则）
  if (opts.canQrCode && opts.onQrCode) {
    tools.push({ icon: <span style={{ fontSize: 14 }}>📱</span>, label: "生成二维码", onClick: opts.onQrCode });
  }
  // 变换枢纽（主操作不是它时，作为次级工具——如按列文本等非 json 内容）
  if (opts.onOpenHub && primaryKey !== "hub") {
    tools.push({ icon: <Sparkles size={14} />, label: "变换为…", onClick: opts.onOpenHub });
  }
  return tools;
}

/** 更多操作子菜单：标签/分组/置顶/片段库等管理项统一收纳 */
function getMoreChildren(opts: CardMenuOpts): MenuItem[] {
  const more: MenuItem[] = [];
  if (opts.onEditTags) {
    more.push({ icon: <Tag size={14} />, label: "编辑标签", onClick: opts.onEditTags });
  }
  if (opts.hasAutoTags && opts.onConfirmAutoTags) {
    more.push({ icon: <span style={{ fontSize: 14 }}>🤖</span>, label: "确认自动标签", onClick: opts.onConfirmAutoTags });
  }
  if (opts.hasAutoTags && opts.onRemoveAutoTags) {
    more.push({ icon: <span style={{ fontSize: 14 }}>🗑️</span>, label: "移除自动标签", onClick: opts.onRemoveAutoTags });
  }
  if (opts.onMoveToGroup) {
    more.push({ icon: <FolderInput size={14} />, label: "移动到分组", onClick: opts.onMoveToGroup, separator: more.length > 0 });
  }
  more.push({ icon: <Pin size={14} />, label: opts.pinned ? "取消置顶" : "置顶", onClick: opts.onPin });
  if (opts.onAddSnippet) {
    more.push({ icon: <FileCode size={14} />, label: "添加到片段库", onClick: opts.onAddSnippet });
  }
  return more;
}

/** 编辑入口的标签文案（按子类型） */
function editLabelFor(st?: string): string {
  const map: Record<string, string> = {
    link: "编辑链接",
    color: "编辑颜色",
    json: "编辑 JSON",
    file_path: "编辑路径",
    markdown: "编辑 Markdown",
    number: "编辑数字",
    secret: "编辑密钥",
    html: "编辑 HTML",
    csv: "编辑表格",
  };
  if (st && map[st]) return map[st];
  if (st && isCodeLike(st)) return "编辑代码";
  return "编辑内容";
}
