/**
 * OcrWordLayer — 图上选词的词框叠加层。
 * 与 <img> 同处一个 transform 容器：词框直接用 OCR 返回的图片像素坐标，
 * 缩放/平移/旋转全程与图片同步（见 useImagePreview 的选词命中逻辑）。
 */
import type { OcrResultData } from "@/hooks/useImagePreview";
import styles from "./CardList.module.css";

export interface OcrWordLayerProps {
  ocrResult: OcrResultData;
  selectedWordIndices: Set<string>;
  onWordClick: (lineIdx: number, wordIdx: number, e: React.MouseEvent) => void;
}

export function OcrWordLayer({ ocrResult, selectedWordIndices, onWordClick }: OcrWordLayerProps) {
  return (
    <div className={styles.ocrOverlayContainer} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {ocrResult.lines.map((line, li) =>
        line.words.map((word, wi) => {
          const key = `${li}-${wi}`;
          const selected = selectedWordIndices.has(key);
          return (
            <div
              key={key}
              data-ocr-word-box
              data-key={key}
              className={`${styles.ocrWordBox}${selected ? ` ${styles.ocrWordSelected}` : ""}`}
              /* ui-rule-ok: 词框几何是 OCR 返回的图片像素坐标（运行期值），只能内联 */
              style={{
                position: "absolute",
                left: word.x,
                top: word.y,
                width: word.width,
                height: word.height,
                border: selected ? "1.5px solid rgba(16,185,129,0.8)" : "1px solid rgba(99,102,241,0.35)",
                /* ui-rule-ok: 2px 微圆角是「贴合文字块的描边」专属刻度，不归 4/8/12 表 */
                borderRadius: 2,
                background: selected ? "rgba(16,185,129,0.18)" : "rgba(99,102,241,0.06)",
                pointerEvents: "auto",
                cursor: "pointer",
                zIndex: selected ? 2 : 1,
              }}
              onClick={(e) => onWordClick(li, wi, e)}
              title={word.text}
            />
          );
        }),
      )}
    </div>
  );
}
