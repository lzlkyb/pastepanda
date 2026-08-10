/**
 * EditableResult.tsx — AI 结果的可编辑展示（M3 偏好学习前置）。
 *
 * 默认展示只读结果 + 「修改」按钮；进入编辑态变成 textarea。
 * 用户改完点「完成」时回调 `onEdited(新文本)` —— 卡片据此记一条
 * "edited" 反馈信号（只记信号，不存改了啥）。
 *
 * 从 TransformCard 拆出：结果编辑是 AI 动作专属交互，不该把卡片撑过 300 行。
 */

import { useEffect, useState } from "react";
import { Pencil, Check, X } from "lucide-react";
import styles from "./EditableResult.module.css";

export function EditableResult({
  output,
  onEdited,
}: {
  output: string;
  /** 用户确认修改后回调（新文本）；不改则不会触发 */
  onEdited?: (newText: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(output);
  const [touched, setTouched] = useState(false);

  // 外部结果变化（重跑/换内容）时重置
  useEffect(() => {
    setText(output);
    setEditing(false);
    setTouched(false);
  }, [output]);

  const commit = () => {
    setEditing(false);
    if (touched && text !== output) onEdited?.(text);
    setTouched(false);
  };

  if (!editing) {
    return (
      <>
        <pre className={styles.preview}>{output}</pre>
        <button className={styles.editBtn} onClick={() => setEditing(true)}>
          <Pencil size={11} /> 修改
        </button>
      </>
    );
  }

  return (
    <div className={styles.editBox}>
      <textarea
        className={styles.editArea}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setTouched(true);
        }}
        spellCheck={false}
      />
      <div className={styles.editActions}>
        <button
          className={styles.cancel}
          onClick={() => {
            setText(output);
            setEditing(false);
            setTouched(false);
          }}
        >
          <X size={12} /> 取消
        </button>
        <button className={styles.done} onClick={commit}>
          <Check size={12} /> 完成
        </button>
      </div>
    </div>
  );
}
