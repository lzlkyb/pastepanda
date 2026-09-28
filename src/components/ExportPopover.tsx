/**
 * ExportPopover — 全屏查看层的导出浮出面板（格式/质量/预估）。
 * 从壳层右下角弹出（设计稿：从「导出」按钮上方），逻辑原样搬运自旧 footer 弹层。
 */
import { FileDown } from "lucide-react";
import {
  EXPORT_FORMATS,
  EXPORT_FORMAT_ORDER,
  formatBytes,
  type ExportFormat,
} from "@/lib/imageFormat";
import type { UseImagePreviewReturn } from "@/hooks/useImagePreview";
import styles from "./CardList.module.css";

export function ExportPopover({ preview }: { preview: UseImagePreviewReturn }) {
  const {
    exportFormat, exportQuality, exportEstimate, exporting,
    setExportFormat, setExportQuality, exportImage, previewImage, previewLoading,
  } = preview;
  if (!previewImage || previewLoading) return null;
  return (
    <div className={styles.fsExportPop} onClick={(e) => e.stopPropagation()}>
      <div className={styles.fsExportRow}>
        <span className={styles.fsExportLabel}>格式</span>
        <div className={styles.fsExportSeg}>
          {EXPORT_FORMAT_ORDER.map((f) => (
            <button
              key={f}
              className={`${styles.fsExportSegBtn}${exportFormat === f ? ` ${styles.fsExportSegBtnOn}` : ""}`}
              onClick={() => setExportFormat(f as ExportFormat)}
            >
              {EXPORT_FORMATS[f].label}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.fsExportRow}>
        <span className={styles.fsExportLabel}>质量</span>
        <input
          type="range"
          min={10}
          max={100}
          step={1}
          value={Math.round(exportQuality * 100)}
          disabled={!EXPORT_FORMATS[exportFormat].lossy}
          onChange={(e) => setExportQuality(Number(e.target.value) / 100)}
          className={styles.fsExportSlider}
          aria-label="导出质量"
        />
        <span className={styles.fsExportPct}>{Math.round(exportQuality * 100)}%</span>
      </div>
      <div className={styles.fsExportRow}>
        <span className={styles.fsExportLabel}>预估</span>
        <span className={styles.fsExportEstimate}>≈ {exportEstimate != null ? formatBytes(exportEstimate) : "…"}</span>
        <span className={styles.fsPanelSp} />
        <button
          className={`${styles.fsPanelBtn} ${styles.fsPanelBtnPri}`}
          onClick={() => void exportImage()}
          disabled={exporting || !previewImage}
        >
          <FileDown size={13} /> {exporting ? "导出中…" : "导出"}
        </button>
      </div>
    </div>
  );
}
