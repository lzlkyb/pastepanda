/**
 * Markdown 类型专属格式栏：加粗/斜体/标题/列表/链接/图片/表格等。
 * 经 ShellBridge 操作外壳持有的 CodeMirror 文档。
 */
import type { ReactNode } from "react";
import {
  Bold, Italic, Strikethrough, Heading,
  Quote, Code, CodeSquare, List, ListOrdered,
  CheckSquare, Link, Image, Table, Minus,
} from "lucide-react";
import type { ShellBridge } from "./types";
import styles from "../FullscreenEditor.module.css";

function FmtBtn({ icon, title, onClick }: { icon: ReactNode; title: string; onClick: () => void }) {
  return (
    <button className={styles.fmtBtn} title={title} onClick={onClick}>
      {icon}
    </button>
  );
}

export function MarkdownFormatBar({ bridge }: { bridge: ShellBridge }) {
  const { insertFormat, insertLinePrefix } = bridge;
  return (
    <>
      <FmtBtn icon={<Bold size={13} />} title="粗体 Ctrl+B" onClick={() => insertFormat("**", "**")} />
      <FmtBtn icon={<Italic size={13} />} title="斜体 Ctrl+I" onClick={() => insertFormat("*", "*")} />
      <FmtBtn icon={<Strikethrough size={13} />} title="删除线" onClick={() => insertFormat("~~", "~~")} />
      <div className={styles.fmtSep} />
      <FmtBtn icon={<Heading size={13} />} title="标题" onClick={() => insertLinePrefix("## ")} />
      <FmtBtn icon={<Quote size={13} />} title="引用" onClick={() => insertLinePrefix("> ")} />
      <FmtBtn icon={<Code size={13} />} title="行内代码" onClick={() => insertFormat("`", "`")} />
      <FmtBtn icon={<CodeSquare size={13} />} title="代码块" onClick={() => insertFormat("\n```\n", "\n```\n")} />
      <div className={styles.fmtSep} />
      <FmtBtn icon={<List size={13} />} title="无序列表" onClick={() => insertLinePrefix("- ")} />
      <FmtBtn icon={<ListOrdered size={13} />} title="有序列表" onClick={() => insertLinePrefix("1. ")} />
      <FmtBtn icon={<CheckSquare size={13} />} title="任务列表" onClick={() => insertLinePrefix("- [ ] ")} />
      <div className={styles.fmtSep} />
      <FmtBtn icon={<Link size={13} />} title="链接" onClick={() => insertFormat("[", "](url)")} />
      <FmtBtn icon={<Image size={13} />} title="图片" onClick={() => insertFormat("![alt](", ")")} />
      <FmtBtn icon={<Table size={13} />} title="表格" onClick={() => insertFormat("\n| 列1 | 列2 |\n| --- | --- |\n| ", " |  |\n")} />
      <FmtBtn icon={<Minus size={13} />} title="分隔线" onClick={() => insertFormat("\n---\n")} />
    </>
  );
}
