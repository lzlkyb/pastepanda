/**
 * RcRenameInput — 设备行内备注编辑（A1，从 RcDeviceList 拆出）。
 * Enter 保存 / Esc 取消；自身吃掉冒泡，不触发整行「发起」。
 */
import { useEffect, useRef, useState } from "react";
import { RC_NOTE_MAX, truncateRcNote } from "@/lib/rcDevice";
import styles from "./RemoteComputer.module.css";

export function RcRenameInput({
  initial,
  name,
  busy,
  onSave,
  onCancel,
}: {
  initial: string;
  /** 对端自报名——placeholder 提示「没起备注时显示的是它」。 */
  name: string;
  busy: boolean;
  onSave: (note: string) => void;
  onCancel: () => void;
}) {
  const [val, setVal] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <div className={styles.renameRow} onClick={(e) => e.stopPropagation()}>
      <input
        ref={ref}
        type="text"
        className={styles.renameInput}
        value={val}
        // ⚠️ 刻意不用 `maxLength`：它数的是 UTF-16 单元，与后端「字符数」不是一个口径
        //    （60 个 emoji 会被它砍成 30 个）。截断统一走 truncateRcNote。
        aria-label="设备备注名"
        title={`只存在本机，不会发给对方。最长 ${RC_NOTE_MAX} 个字符，留空 = 显示对方的自报名`}
        placeholder={name}
        onChange={(e) => setVal(truncateRcNote(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSave(val);
          else if (e.key === "Escape") onCancel();
        }}
      />
      <button
        type="button"
        className={styles.miniBtnPri}
        disabled={busy}
        title="保存在本机，不会发给对方"
        onClick={() => onSave(val)}
      >
        保存
      </button>
      <button type="button" className={styles.miniBtn} onClick={onCancel}>
        取消
      </button>
    </div>
  );
}
