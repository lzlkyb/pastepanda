/**
 * ImagePreviewDialog — 宽幅图片详情弹框（设计稿 design/记录模式图片详情-弹框风格统一-设计稿.html）。
 *
 * 壳：复用通用弹框的标题栏和窗体材质，图片仍占主要空间。
 * 芯：底部一条操作栏（ImageToolbar），OCR 摘要 / 导出 / 码面板互斥浮出
 *     （OcrSummaryPanel / ExportPopover / BarcodePanel），面板互斥收口在 hook 的 activePanel。
 * OCR 零二次识别：全文进场即从列表缓存带出（item.ocr_text），词框只在「选词」时按需跑。
 */
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { FocusTrap } from "@/components/FocusTrap";
import { useDialogAnim } from "@/lib/dialogMotion";
import { useToast } from "@/components/Toast";
import { barcodeBoundingRect } from "@/lib/utils";
import { shouldZoomImageWheel } from "@/lib/imagePreviewWheel";
import { useDialogStore } from "@/stores/dialogStore";
import { useImageBarcodes } from "@/hooks/useImageBarcodes";
import { BarcodePanel } from "@/components/BarcodePanel";
import { ImageToolbar } from "@/components/ImageToolbar";
import { OcrSummaryPanel } from "@/components/OcrSummaryPanel";
import { OcrWordLayer } from "@/components/OcrWordLayer";
import { ExportPopover } from "@/components/ExportPopover";
import { CropOverlay, CropConfirmBar } from "@/components/CropOverlay";
import type { UseImagePreviewReturn } from "@/hooks/useImagePreview";
import styles from "./CardList.module.css";
import { useModalScrollLock } from "@/contexts/ScrollContext";

export interface ImagePreviewDialogProps {
  preview: UseImagePreviewReturn;
}

/** 选词框选矩形的描边色：与 OcrWordLayer 词框选中态同族（indigo #6366f1）。
 *  截图/OCR 系沿用的运行期常量，全项目统一取这一份。 */
const SEL_RECT_BORDER = "1px dashed #6366f1"; /* ui-rule-ok: 选词系运行期色常量，与词框选中态同族 */
const SEL_RECT_BG = "rgba(99,102,241,0.1)";

export function ImagePreviewDialog({ preview }: ImagePreviewDialogProps) {
  const { toast } = useToast();
  const anim = useDialogAnim();
  // 打开查看层时暂停主窗口 Lenis 平滑滚动（dialog.css .dialog-backdrop 另有 overscroll 兜底）
  useModalScrollLock();
  const {
    previewImage, previewInfo, previewLoading,
    previewScale, fitScale, previewRotation, previewOffset, isPanning,
    onPreviewImageLoad,
    previewContentRef, viewportRef, previewItem,
    ocrResult, ocrLoading, ocrActive, selectedWordIndices, isSelecting, selRect,
    activePanel, setActivePanel,
    cropMode, cropRect, cropOriginal,
    closePreview,
    handleCropMouseDown, handleCropMouseMove, handleCropMouseUp,
    confirmCrop, cancelCrop, restoreOriginal,
    handlePreviewWheel, handlePanStart, handlePanMove, handlePanEnd,
    handleOcrWordClick, handleOcrSelectStart,
  } = preview;

  const imageBarcodes = useImageBarcodes(previewImage, previewContentRef, previewItem?.barcodes);
  const [hoveredCodeIdx, setHoveredCodeIdx] = useState<number | null>(null);
  const hoveredCodeRect = hoveredCodeIdx != null && imageBarcodes.hits[hoveredCodeIdx]
    ? barcodeBoundingRect(imageBarcodes.hits[hoveredCodeIdx].points)
    : null;

  // 模式 → 面板互斥的声明式收口：选词态顶替摘要面板，裁剪态收起一切浮层
  useEffect(() => { if (ocrActive) setActivePanel("ocr"); }, [ocrActive, setActivePanel]);
  useEffect(() => { if (cropMode) setActivePanel(null); }, [cropMode, setActivePanel]);

  // 操作提示：进场显示 3s 后淡化；鼠标移出图区即彻底收走（不再常驻两份重复提示）
  const [hintState, setHintState] = useState<"show" | "faded" | "gone">("show");
  useEffect(() => {
    setHintState("show");
    const t = setTimeout(() => setHintState((s) => (s === "show" ? "faded" : s)), 3000);
    return () => clearTimeout(t);
  }, [previewImage]);

  // 点图区空白 = 收起当前浮层面板（§18「一键可推翻」）。
  // ❗ 拖拽平移后浏览器仍会补一个 click —— 不识别就把「刚平移完」当成「点空白」把面板收走。
  const pannedRef = useRef(false);

  const handleCopyImage = async () => {
    try {
      const { copyImageOnly } = await import("@/lib/api");
      await copyImageOnly(previewContentRef.current!);
      toast("已复制", "success");
    } catch { toast("复制失败", "error"); }
  };

  /** 高频一步：Enter = 复制图片。
   *  让位给三类焦点宿主，否则 Enter 会「点按钮」和「复制图」一起触发：
   *  裁剪态（Enter=确认裁剪）、输入/编辑态（OCR 校对）、聚焦的按钮/链接（Enter=点击它自己）。 */
  useEffect(() => {
    if (!previewImage) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || cropMode) return;
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      if (t instanceof HTMLButtonElement || t instanceof HTMLAnchorElement || t.isContentEditable) return;
      void handleCopyImage();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewImage, cropMode]);

  // 裁剪拖拽：mousedown 在 overlay 上触发，move/up 挂在 window 上以便拖出视口仍能跟踪。
  useEffect(() => {
    if (!cropMode) return;
    const onMove = (e: MouseEvent) => handleCropMouseMove(e as unknown as React.MouseEvent);
    const onUp = () => handleCropMouseUp();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void confirmCrop();
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("keydown", onKey);
    };
  }, [cropMode, handleCropMouseMove, handleCropMouseUp, confirmCrop]);

  const handleOpenHub = (text: string) => {
    if (!previewItem) return;
    const item = previewItem;
    closePreview();
    useDialogStore.getState().openHub(item, text);
  };

  return (
    <AnimatePresence>
      {(previewImage || previewLoading) && (
        <motion.div {...anim.backdrop} className="dialog-backdrop" onClick={closePreview}>
          <FocusTrap>
            <motion.div {...anim.panel} className={`dialog-box ${styles.fsShell}`} onClick={(e) => e.stopPropagation()}>
              {/* 与其他详情弹框同一标题栏；长文件名在可用空间内截断。 */}
              <div className={`dialog-header ${styles.fsTop}`}>
                <h2 className="dialog-title">图片详情</h2>
                {previewInfo && (
                  <div className={styles.fsMeta}>
                    <span className={styles.fsMetaName} title={previewInfo.file_name}>{previewInfo.file_name}</span>
                    <span>{previewInfo.width} × {previewInfo.height}</span>
                    <span>{previewInfo.size_str}</span>
                  </div>
                )}
                <button className="dialog-close" onClick={closePreview} title="关闭（Esc）" aria-label="关闭图片详情"><X size={16} /></button>
              </div>

              {/* 图区 */}
              <div
                ref={viewportRef}
                className={styles.fsViewport}
                data-cursor={ocrActive ? (isSelecting ? "crosshair" : "text") : isPanning ? "grabbing" : previewScale > fitScale * 1.001 ? "grab" : "default"}
                onWheel={(e) => { if (shouldZoomImageWheel(e.target)) handlePreviewWheel(e); }}
                onMouseDown={ocrActive ? handleOcrSelectStart : handlePanStart}
                onMouseMove={ocrActive ? undefined : (e) => { if (isPanning) pannedRef.current = true; handlePanMove(e); }}
                onMouseUp={ocrActive ? undefined : handlePanEnd}
                onMouseLeave={() => { handlePanEnd(); setHintState("gone"); }}
                onClick={() => { if (pannedRef.current) { pannedRef.current = false; return; } setActivePanel(null); }}
              >
                {previewLoading && (
                  <div className={styles.imageDetailLoading}>
                    <div className={styles.imageDetailSpinner} />
                    <span>加载中…</span>
                  </div>
                )}
                {previewImage && (
                  <div
                    className={styles.imageDetailTransform}
                    /* ui-rule-ok: 缩放/平移/旋转是运行期交互状态，只能内联 */
                    style={{
                      transform: `translate(${previewOffset.x}px, ${previewOffset.y}px) scale(${previewScale}) rotate(${previewRotation}deg)`,
                      transition: isPanning ? "none" : "transform 0.2s ease-out",
                    }}
                  >
                    <img src={previewImage} alt="预览" className={styles.imageDetailImg} draggable={false} onLoad={onPreviewImageLoad} />
                    {ocrActive && ocrResult && !cropMode && (
                      <OcrWordLayer ocrResult={ocrResult} selectedWordIndices={selectedWordIndices} onWordClick={handleOcrWordClick} />
                    )}
                    {hoveredCodeRect && (
                      <div
                        className={styles.codeRectOverlay}
                        /* ui-rule-ok: 码位框几何是解码结果里的图片像素坐标（运行期值），只能内联 */
                        style={{
                          position: "absolute",
                          left: hoveredCodeRect.x,
                          top: hoveredCodeRect.y,
                          width: hoveredCodeRect.width,
                          height: hoveredCodeRect.height,
                        }}
                      />
                    )}
                  </div>
                )}
                {isSelecting && selRect && (
                  /* ui-rule-ok: 框选矩形几何+色值均为运行期值（SEL_RECT_* 常量收口于文件头） */
                  <div style={{
                    position: "absolute", left: selRect.x, top: selRect.y,
                    width: selRect.w, height: selRect.h,
                    border: SEL_RECT_BORDER, background: SEL_RECT_BG,
                    pointerEvents: "none", zIndex: 10,
                  }} />
                )}
                {cropMode && previewImage && !previewLoading && (
                  <CropOverlay
                    cropRect={cropRect}
                    cropOriginal={cropOriginal}
                    onMouseDown={handleCropMouseDown}
                    onRestore={restoreOriginal}
                  />
                )}
                {/* 浮层锚定图片画布底边，底部操作区在窄窗口换行时也不会盖住浮层。 */}
                <div className={`${styles.fsHint}${hintState === "faded" ? ` ${styles.fsHintFaded}` : ""}${hintState === "gone" ? ` ${styles.fsHintGone}` : ""}`}>
                  滚轮缩放 · 拖拽平移 · 0 适应 · R 旋转 · Enter 复制
                </div>
                <div className={styles.fsOverlayLayer} data-image-preview-overlay>
                  {(ocrActive ? activePanel !== "codes" && activePanel !== "export" : activePanel === "ocr") && (
                    <OcrSummaryPanel preview={preview} onOpenHub={handleOpenHub} mode={ocrActive ? "selection" : "summary"} />
                  )}
                  {activePanel === "codes" && (
                    <div className={styles.fsPanel} onClick={(e) => e.stopPropagation()}>
                      <BarcodePanel
                        hits={imageBarcodes.hits}
                        onHover={setHoveredCodeIdx}
                        open
                        onOpenChange={(v) => { if (!v) setActivePanel(null); }}
                      />
                    </div>
                  )}
                  {activePanel === "export" && <ExportPopover preview={preview} />}
                </div>
                {ocrLoading && <div className={styles.fsOcrWorking}>正在识别文字…</div>}
              </div>

              <div className={`dialog-footer ${styles.fsToolbarWrap}`}>
                {cropMode ? (
                  <CropConfirmBar cropRect={cropRect} onConfirm={() => void confirmCrop()} onCancel={cancelCrop} />
                ) : (
                  <ImageToolbar
                    preview={preview}
                    activePanel={activePanel}
                    onPanel={setActivePanel}
                    codeCount={imageBarcodes.hits.length}
                    onCopyImage={() => void handleCopyImage()}
                  />
                )}
              </div>
            </motion.div>
          </FocusTrap>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
