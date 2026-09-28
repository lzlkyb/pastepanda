/**
 * ImageToolbar — 全屏查看层底部唯一一条胶囊工具栏（设计稿「C壳+B芯」）。
 *
 * 三组：缩放（−/%/＋/1:1/⟳）｜模式（选词·裁剪·置顶·码）｜动作（复制·另存·导出）。
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
    previewScale, setPreviewScale, setPreviewOffset, setPreviewRotation,
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
      <button className={styles.fsToolBtn} title="缩小（-）" onClick={() => setPreviewScale((s) => Math.max(0.2, s - 0.25))}><ZoomOut size={14} /></button>
      <span className={styles.fsToolZoom}>{Math.round(previewScale * 100)}%</span>
      <button className={styles.fsToolBtn} title="放大（+）" onClick={() => setPreviewScale((s) => Math.min(5, s + 0.25))}><ZoomIn size={14} /></button>
      <button className={styles.fsToolBtn} title="复位 100%（0）" onClick={() => { setPreviewScale(1); setPreviewOffset({ x: 0, y: 0 }); }}>1:1</button>
      <button className={styles.fsToolBtn} title="旋转 90°（R）" onClick={() => setPreviewRotation((r) => (r + 90) % 360)}><RotateCw size={14} /></button>

      <span className={styles.fsToolSep} />

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
      >
        <Scissors size={14} /> 裁剪
      </button>
      <button className={styles.fsToolBtn} title="将图片钉在屏幕最上层" onClick={handlePinImage}>
        <Pin size={14} /> 置顶
      </button>
      {codeCount > 0 && panelBtn("codes", `▦ 码 ${codeCount}`, "查看识别到的二维码 / 条码")}

      <span className={styles.fsToolSep} />

      <button
        className={`${styles.fsToolBtn} ${styles.fsToolBtnAct}`}
        title="复制图片（Enter）"
        onClick={() => void handleCopy()}
      >
        <Copy size={14} /> {copied ? "已复制" : "复制"}
      </button>
      <button className={styles.fsToolBtn} title="原图另存为…" onClick={() => void handleSaveAs()}>
        <Download size={14} /> 另存
      </button>
      {panelBtn("export", "导出", "格式转换 + 压缩导出")}
    </div>
  );
}
