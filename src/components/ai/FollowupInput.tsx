/**
 * FollowupInput —— 追问输入框（结果卡下常驻，Enter 或按钮发送）。
 *
 * AiQuickBar 与 TransformCard 两处共用。以前它寄在 AiQuickBar.tsx 里、
 * 由 TransformCard 反向 import，拆子组件时会直接变成环依赖，所以独立成文件。
 */
import { useState } from "react";
import { Loader2 } from "lucide-react";
import styles from "./FollowupInput.module.css";

export function FollowupInput({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (q: string) => void;
}) {
  const [val, setVal] = useState("");
  const submit = () => {
    if (!val.trim() || disabled) return;
    onSubmit(val);
    setVal("");
  };
  return (
    <div className={styles.followRow}>
      <input
        className={styles.followInput}
        placeholder="追问：再短一点 / 翻译成英文…（Enter 发送）"
        value={val}
        disabled={disabled}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />
      <button className={styles.followGo} disabled={disabled || !val.trim()} onClick={submit}>
        {disabled ? <Loader2 size={11} className="spin" /> : "追问"}
      </button>
    </div>
  );
}
