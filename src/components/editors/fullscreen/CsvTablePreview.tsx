/**
 * CSV 类型专属预览：全宽表格网格（首行表头 + 行号列 + 斑马纹 + 悬停高亮）。
 * 解析器复用 src/lib/csv.ts（与 Rust 分类器规则对齐）；结构不一致时回退提示。
 */
import { useMemo } from "react";
import { parseCsv } from "@/lib/csv";
import styles from "../FullscreenEditor.module.css";

export function CsvTablePreview({ text }: { text: string }) {
  const data = useMemo(() => parseCsv(text), [text]);

  if (!data) {
    return (
      <div className={styles.csvInvalidHint}>
        无法解析为表格：需至少 2 行且各行列数一致（≥2 列）。可切换到编辑模式查看原文。
      </div>
    );
  }

  return (
    <div className={styles.csvTableWrap}>
      <table className={styles.csvTable}>
        <thead>
          <tr>
            <th className={styles.csvIdx}></th>
            {data.headers.map((h, i) => (
              <th key={i}>{h || `列 ${i + 1}`}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r, ri) => (
            <tr key={ri}>
              <td className={styles.csvIdx}>{ri + 2}</td>
              {r.map((c, ci) => (
                <td key={ci}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
