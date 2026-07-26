/**
 * 代码类型专属格式栏：注释/缩进/清理。
 * 注释与缩进经 ShellBridge 调 CodeMirror 命令（跟随当前语言语法），
 * 清理类为全文变换（经 replaceDoc，自动触发脏标记/自动保存）。
 */
import type { ReactNode } from "react";
import { MessageSquare, Indent, Outdent, Scissors, AlignLeft } from "lucide-react";
import type { ShellBridge } from "./types";
import styles from "../FullscreenEditor.module.css";

function FmtBtn({ icon, title, onClick }: { icon: ReactNode; title: string; onClick: () => void }) {
  return (
    <button className={styles.fmtBtn} title={title} onClick={onClick}>
      {icon}
    </button>
  );
}

export function CodeFormatBar({ bridge }: { bridge: ShellBridge }) {
  const { toggleComment, indentMore, indentLess, text, replaceDoc } = bridge;
  return (
    <>
      <FmtBtn icon={<MessageSquare size={13} />} title="注释/取消注释（选区或当前行）" onClick={toggleComment} />
      <FmtBtn icon={<Indent size={13} />} title="增加缩进" onClick={indentMore} />
      <FmtBtn icon={<Outdent size={13} />} title="减少缩进" onClick={indentLess} />
      <div className={styles.fmtSep} />
      <FmtBtn icon={<Scissors size={13} />} title="去首尾空白" onClick={() => replaceDoc(text.trim())} />
      <FmtBtn icon={<AlignLeft size={13} />} title="去空行" onClick={() => replaceDoc(text.split("\n").filter((l) => l.trim()).join("\n"))} />
    </>
  );
}
