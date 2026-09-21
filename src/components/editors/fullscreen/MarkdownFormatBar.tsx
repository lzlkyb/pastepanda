/**
 * Markdown 类型专属格式栏（稿子 P0-5 收束版）。
 *
 * 原版是 14 个常驻裸图标，需逐个猜且占一整行；收成：
 *   查找（直达）｜粗体/斜体/删除线/行内代码（高频字形 cluster，直达）
 *   ｜标题 / 列表 / 引用与代码块 / 插入（4 个带文字菜单）
 * 原 14 个操作**一个不少**：标题(H1-H3)、引用、代码块、无序/有序/任务列表、
 * 链接、图片、表格、分隔线全部进了菜单 —— 只是收纳，不删功能。
 *
 * 经 ShellBridge 操作外壳持有的 CodeMirror 文档。
 */
import type { ReactNode } from "react";
import { ChevronDown, Search, Bold, Italic, Strikethrough, Code } from "lucide-react";
import { DropdownMenu, type MenuEntry } from "./DropdownMenu";
import type { ShellBridge } from "./types";
import styles from "../FullscreenEditor.module.css";

function FmtBtn({ icon, title, onClick }: { icon: ReactNode; title: string; onClick: () => void }) {
  return (
    <button className={styles.fmtBtn} title={title} onClick={onClick}>
      {icon}
    </button>
  );
}

/** 带文字的菜单触发器（「标题 ▾」） */
function FmtMenu({ label, entries }: { label: string; entries: MenuEntry[] }) {
  return (
    <DropdownMenu
      trigger={
        <>
          <span>{label}</span>
          <ChevronDown size={12} />
        </>
      }
      triggerClassName={styles.fmtMenuBtn}
      triggerTitle={label}
      entries={entries}
      align="left"
      menuClassName={styles.fmtMenuPop}
    />
  );
}

export function MarkdownFormatBar({ bridge }: { bridge: ShellBridge }) {
  const { insertFormat, insertLinePrefix, openSearch } = bridge;

  const titleEntries: MenuEntry[] = [
    { key: "h1", label: "标题 1", kbd: "#", onSelect: () => insertLinePrefix("# ") },
    { key: "h2", label: "标题 2", kbd: "##", onSelect: () => insertLinePrefix("## ") },
    { key: "h3", label: "标题 3", kbd: "###", onSelect: () => insertLinePrefix("### ") },
  ];
  const listEntries: MenuEntry[] = [
    { key: "ul", label: "无序列表", icon: "•", onSelect: () => insertLinePrefix("- ") },
    { key: "ol", label: "有序列表", icon: "1.", onSelect: () => insertLinePrefix("1. ") },
    { key: "task", label: "任务列表", icon: "☐", onSelect: () => insertLinePrefix("- [ ] ") },
  ];
  const blockEntries: MenuEntry[] = [
    { key: "quote", label: "引用", icon: "❝", onSelect: () => insertLinePrefix("> ") },
    { key: "codeblock", label: "代码块", icon: "▢", onSelect: () => insertFormat("\n```\n", "\n```\n") },
  ];
  const insertEntries: MenuEntry[] = [
    { key: "link", label: "链接", kbd: "[]()", onSelect: () => insertFormat("[", "](url)") },
    { key: "image", label: "图片", onSelect: () => insertFormat("![alt](", ")") },
    {
      key: "table",
      label: "表格",
      onSelect: () => insertFormat("\n| 列1 | 列2 |\n| --- | --- |\n| ", " |  |\n"),
    },
    { key: "hr", label: "分隔线", onSelect: () => insertFormat("\n---\n") },
  ];

  return (
    <>
      {/* L2：带「查找」二字，不只放大镜——快捷键对小白不可发现 */}
      <button className={styles.fmtBtnText} title="查找 Ctrl+F" onClick={openSearch}>
        <Search size={13} />
        <span>查找</span>
      </button>
      <div className={styles.fmtSep} />
      {/* 高频字形直达 cluster（稿子 demo：B I S </>） */}
      <FmtBtn icon={<Bold size={13} />} title="粗体 Ctrl+B" onClick={() => insertFormat("**", "**")} />
      <FmtBtn icon={<Italic size={13} />} title="斜体 Ctrl+I" onClick={() => insertFormat("*", "*")} />
      <FmtBtn icon={<Strikethrough size={13} />} title="删除线" onClick={() => insertFormat("~~", "~~")} />
      <FmtBtn icon={<Code size={13} />} title="行内代码" onClick={() => insertFormat("`", "`")} />
      <div className={styles.fmtSep} />
      <FmtMenu label="标题" entries={titleEntries} />
      <FmtMenu label="列表" entries={listEntries} />
      <FmtMenu label="引用与代码块" entries={blockEntries} />
      <FmtMenu label="插入" entries={insertEntries} />
    </>
  );
}
