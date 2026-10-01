/**
 * ImageToolbar — 图片详情宽幅弹框底部的操作栏。
 *
 * 主行：缩放/适应/原尺寸/复制；次行：其它处理操作。窄窗口允许次行换行。
 * 面板互斥由父级收口：本组件只上报意图（onPanel），不持有 activePanel。
 * 「T」按钮语义随状态：已有全文（缓存或词框）→「选词」；没有 →「识别文字」。
 * 常驻文字标签是底线（UI 规则 L2），hover title 只补快捷键。
 */
import { useState } from "react";
import { ZoomIn, ZoomOut, RotateCw, ScanText, Scissors, Pin, Copy, Download } from "lucide-react";
import { useToast } from "@/components/Toast";
import type { UseImagePreviewReturn } from "@/hooks/useImagePreview";
import type { PanelId } from "./imagePreviewPanels";
import styles from "./CardList.module.css";

export interface ImageToolbarProps {
  preview: UseImagePreviewReturn;
  /** 当前浮出的面板（父级持有，互斥收口点） */
  activePanel: PanelId;
  onPanel: (p: PanelId) => void;
  /** 图上识别到的码数量（0 = 不渲染「码」按钮，零可见） */
  codeCount: number;
  /** 复制图片（默认动作，Enter 同义）——实现留在壳层（要用全局 toast/导入） */
  onCopyImage: () => void;
}

export function ImageToolbar({ preview, activePanel, onPanel, codeCount, onCopyImage }: ImageToolbarProps) {
  const { toast } = useToast();
  const {
    previewScale, isFitMode, fitPreview, zoomPreview, showActualSize, rotatePreview,
    ocrResult, ocrCachedText, ocrActive, ocrLoading, cropMode,
    toggleOcrOverlay, toggleCropMode, handlePinImage,
  } = preview;
  const [copied, setCopied] = useState(false);

  const hasOcrText = ocrResult != null || ocrCachedText != null;

  const handleCopy = async () => {
    onCopyImage();
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleSaveAs = async () => {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { invoke } = await import("@tauri-apps/api/core");
      const defaultName = String(preview.previewInfo?.file_name || "image.png");
      const path = await save({ defaultPath: defaultName, filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }] });
      if (path && preview.previewContentRef.current) {
        await invoke("save_image_file", { source: preview.previewContentRef.current, dest: path });
        toast("已保存", "success");
      }
    } catch { toast("保存失败", "error"); }
  };

  const panelBtn = (id: PanelId, label: string, title: string) => (
    <button
      className={`${styles.fsToolBtn}${activePanel === id ? ` ${styles.fsToolBtnOn}` : ""}`}
      title={title}
      onClick={() => onPanel(activePanel === id ? null : id)}
    >
      {label}
    </button>
  );

  return (
    <div className={styles.fsToolbar}>
      <div className={styles.fsToolbarMain}>
        <div className={styles.fsToolGroup}>
          <button className={styles.fsToolBtn} title="缩小（-）" aria-label="缩小图片" onClick={() => zoomPreview(0.8)}><ZoomOut size={14} /></button>
          <span className={styles.fsToolZoom}>{Math.round(previewScale * 100)}%</span>
          <button className={styles.fsToolBtn} title="放大（+）" aria-label="放大图片" onClick={() => zoomPreview(1.25)}><ZoomIn size={14} /></button>
          <button className={`${styles.fsToolBtn}${isFitMode ? ` ${styles.fsToolBtnOn}` : ""}`} title="完整显示图片（0）" onClick={fitPreview}>适应</button>
          <button className={styles.fsToolBtn} title="按原始像素显示" onClick={showActualSize}>1:1</button>
        </div>
        <button className="btn-primary" title="复制图片（Enter）" onClick={() => void handleCopy()}><Copy size={14} /> {copied ? "已复制" : "复制"}</button>
      </div>
      <div className={styles.fsToolbarSecondary}>
        <button className={styles.fsToolBtn} title="旋转 90°（R）" onClick={rotatePreview}><RotateCw size={14} /> 旋转</button>
        <button
          className={`${styles.fsToolBtn}${ocrActive ? ` ${styles.fsToolBtnOn}` : ""}`}
          title={ocrActive ? "退出选词（Esc）" : hasOcrText ? "在图上点选/框选文字" : "识别图片中的文字"}
          onClick={toggleOcrOverlay}
          disabled={ocrLoading}
        >
          {ocrLoading ? <span className={styles.fsToolSpinner} /> : <ScanText size={14} />}
          {hasOcrText ? "选词" : "识别文字"}
        </button>
        <button
          className={`${styles.fsToolBtn}${cropMode ? ` ${styles.fsToolBtnOn}` : ""}`}
          title={cropMode ? "退出裁剪（Esc）" : "裁剪图片"}
          onClick={toggleCropMode}
        ><Scissors size={14} /> 裁剪</button>
        <button className={styles.fsToolBtn} title="将图片钉在屏幕最上层" onClick={handlePinImage}><Pin size={14} /> 置顶</button>
        {codeCount > 0 && panelBtn("codes", `码 ${codeCount}`, "查看识别到的二维码 / 条码")}
        <button className={styles.fsToolBtn} title="原图另存为…" onClick={() => void handleSaveAs()}><Download size={14} /> 另存</button>
        {panelBtn("export", "导出", "格式转换 + 压缩导出")}
      </div>
    </div>
  );
}
