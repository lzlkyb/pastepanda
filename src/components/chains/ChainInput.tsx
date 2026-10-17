import { Copy } from "lucide-react";
import styles from "../ChainRunnerDialog.module.css";

export function ChainInput({ value, onChange, disabled = false }: {
  value: string; onChange: (text: string) => void; disabled?: boolean;
}) {
  return <details className={styles.source}>
    <summary><Copy size={14} /><span className={styles.sourceMain}>当前内容 <small>{value.length} 字</small>
      <span className={styles.excerpt}>{value || "没有文字，请展开填写"}</span></span><span className={styles.sourceLink}>查看 / 修改</span></summary>
    <textarea className={styles.input} aria-label="当前内容" value={value} disabled={disabled}
      onChange={e => onChange(e.target.value)} rows={5} />
    <p className={styles.hint}>后续处理使用这里的文字，不会修改原记录。</p>
  </details>;
}
