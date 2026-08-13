/**
 * 「从 Mermaid 导入」弹窗。自己持有输入与错误态，对外只暴露 onImport：
 * 返回错误文案表示解析失败并留在弹窗内，返回 null 表示已成功应用。
 */
import { useState } from "react";
import styles from "../DiagramCanvas.module.css";

const PLACEHOLDER = "flowchart TD\n  A[开始] --> B[处理]\n  B --> C{判断?}\n  C -->|是| D[完成]\n  C -->|否| B";

export function MermaidImportModal({
  onImport, onClose,
}: {
  onImport: (text: string) => string | null;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className={styles.modalOverlay} onMouseDown={onClose}>
      <div className={styles.modal} onMouseDown={(e) => e.stopPropagation()}>
        <div className={styles.modalTitle}>从 Mermaid 导入</div>
        <p className={styles.modalHint}>粘贴 Mermaid 文本（flowchart / graph），将替换当前画布内容：</p>
        <textarea
          className={styles.modalTextarea}
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          placeholder={PLACEHOLDER}
          spellCheck={false}
        />
        {err && <div className={styles.modalError}>{err}</div>}
        <div className={styles.modalActions}>
          <button className={styles.ghostBtn} onClick={onClose}>取消</button>
          <button className={styles.primaryBtn} onClick={() => setErr(onImport(text))} disabled={!text.trim()}>
            解析并导入
          </button>
        </div>
      </div>
    </div>
  );
}
