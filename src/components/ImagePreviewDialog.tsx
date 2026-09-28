/**
 * ImagePreviewDialog — 图片全屏查看层（「C壳+B芯」重做，设计稿 design/图片详情-全屏查看层重做-设计稿.html）。
 *
 * 壳：720px 模态框 → 全屏覆盖层，图片吃满；元信息变左上角半透明胶囊（hover 浮现）。
 * 芯：底部一条胶囊工具栏（ImageToolbar），OCR 摘要 / 导出 / 码面板互斥浮出
 *     （OcrSummaryPanel / ExportPopover / BarcodePanel），面板互斥收口在 hook 的 activePanel。
 * OCR 零二次识别：全文进场即从列表缓存带出（item.ocr_text），词框只在「选词」时按需跑。
 */
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Check, RotateCcw } from "lucide-react";
import { FocusTrap } from "@/components/FocusTrap";
import { useDialogAnim } from "@/lib/dialogMotion";
import { useToast } from "@/components/Toast";
import { barcodeBoundingRect } from "@/lib/utils";
import { useDialogStore } from "@/stores/dialogStore";
import { useImageBarcodes } from "@/hooks/useImageBarcodes";
import { BarcodePanel } from "@/components/BarcodePanel";
import { ImageToolbar } from "@/components/ImageToolbar";
import { OcrSummaryPanel } from "@/components/OcrSummaryPanel";
import { OcrWordLayer } from "@/components/OcrWordLayer";
import { ExportPopover } from "@/components/ExportPopover";
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
    previewScale, previewRotation, previewOffset, isPanning,
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
            <motion.div {...anim.panel} className={styles.fsShell} onClick={(e) => e.stopPropagation()}>
              {/* 顶栏：元信息胶囊（hover 浮现）+ 关闭 */}
              <div className={styles.fsTop}>
                {previewInfo && (
                  <div className={styles.fsMeta}>
                    <span className={styles.fsMetaName}>📄 {previewInfo.file_name}</span>
                    <span>{previewInfo.width} × {previewInfo.height}</span>
                    <span>{previewInfo.size_str}</span>
                  </div>
                )}
                <span className={styles.fsTopSp} />
                <button className={styles.fsClose} onClick={closePreview} title="关闭（Esc）"><X size={16} /></button>
              </div>

              {/* 图区 */}
              <div
                ref={viewportRef}
                className={styles.fsViewport}
                data-cursor={ocrActive ? (isSelecting ? "crosshair" : "text") : isPanning ? "grabbing" : previewScale > 1 ? "grab" : "default"}
                onWheel={handlePreviewWheel}
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
                    <img src={previewImage} alt="预览" className={styles.imageDetailImg} draggable={false} />
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
                  <>
                    <div className={styles.cropBackdrop} onMouseDown={handleCropMouseDown} style={{ cursor: "crosshair" }} />
                    {cropRect && (
                      <>
                        <div className={styles.cropMask} style={{ top: 0, left: 0, right: 0, height: cropRect.y }} />
                        <div className={styles.cropMask} style={{ bottom: 0, left: 0, right: 0, height: `calc(100% - ${cropRect.y + cropRect.h}px)` }} />
                        <div className={styles.cropMask} style={{ top: cropRect.y, left: 0, width: cropRect.x, height: cropRect.h }} />
                        <div className={styles.cropMask} style={{ top: cropRect.y, right: 0, width: `calc(100% - ${cropRect.x + cropRect.w}px)`, height: cropRect.h }} />
                        <div className={styles.cropSel} style={{ left: cropRect.x, top: cropRect.y, width: cropRect.w, height: cropRect.h }}>
                          <div className={styles.cropGridH} style={{ top: "33.333%" }} />
                          <div className={styles.cropGridH} style={{ top: "66.667%" }} />
                          <div className={styles.cropGridV} style={{ left: "33.333%" }} />
                          <div className={styles.cropGridV} style={{ left: "66.667%" }} />
                          {(["tl", "tc", "tr", "ml", "mr", "bl", "bc", "br"] as const).map((name) => (
                            <div
                              key={name}
                              className={`${styles.cropHandle}${name.length === 2 && !name.includes("c") ? ` ${styles.cropHandleCorner}` : ""}`}
                              /* ui-rule-ok: 手柄定位由手柄方位决定（运行期枚举），只能内联 */
                              style={
                                name === "tl" ? { left: -5, top: -5, cursor: "nwse-resize" }
                                : name === "tc" ? { left: "50%", top: -5, cursor: "ns-resize", transform: "translateX(-50%)" }
                                : name === "tr" ? { right: -5, top: -5, cursor: "nesw-resize" }
                                : name === "ml" ? { left: "50%", top: "50%", cursor: "ew-resize", transform: "translateY(-50%)" }
                                : name === "mr" ? { right: -5, top: "50%", cursor: "ew-resize", transform: "translateY(-50%)" }
                                : name === "bl" ? { left: -5, bottom: -5, cursor: "nesw-resize" }
                                : name === "bc" ? { left: "50%", bottom: -5, cursor: "ns-resize", transform: "translateX(-50%)" }
                                : { right: -5, bottom: -5, cursor: "nwse-resize" }
                              }
                            />
                          ))}
                          <div className={styles.cropHintBar}><span>{Math.round(cropRect.w)} × {Math.round(cropRect.h)}</span></div>
                        </div>
                      </>
                    )}
                    {cropOriginal && (
                      <button className={styles.fsRestoreBtn} onClick={(e) => { e.stopPropagation(); restoreOriginal(); }} title="还原原图">
                        <RotateCcw size={13} /> 还原原图
                      </button>
                    )}
                  </>
                )}
              </div>

              {/* 提示胶囊（进场 3s 后淡化，hover 过图区即消失） */}
              <div className={`${styles.fsHint}${hintState === "faded" ? ` ${styles.fsHintFaded}` : ""}${hintState === "gone" ? ` ${styles.fsHintGone}` : ""}`}>
                滚轮缩放 · 拖拽平移 · 0 复位 · R 旋转 · Enter 复制
              </div>

              {/* 裁剪确认栏（顶替工具栏位置，主工具栏压暗） */}
              {cropMode && (
                <div className={styles.fsCropBar}>
                  <span>拖拽绘制选区 · 拖动手柄调整 · Enter 确认</span>
                  <button
                    className={`${styles.fsPanelBtn} ${styles.fsPanelBtnPri}`}
                    onClick={() => void confirmCrop()}
                    disabled={!cropRect || cropRect.w < 10 || cropRect.h < 10}
                  >
                    <Check size={13} /> 确认裁剪
                  </button>
                  <button className={styles.fsPanelBtn} onClick={cancelCrop}>取消</button>
                </div>
              )}

              {/* 浮出面板（互斥收口在 activePanel；选词条让位给码/导出，切回即恢复——选区不清） */}
              {(ocrActive ? activePanel !== "codes" && activePanel !== "export" : activePanel === "ocr") && (
                <OcrSummaryPanel preview={preview} onOpenHub={handleOpenHub} mode={ocrActive ? "selection" : "summary"} />
              )}
              {/* 码面板：只在「码」槽位激活时渲染（互斥）；抽屉样式借旧件，外框借 fsPanel，
                  样式由 CSS 里 .fsPanel > .ocrFullTextPanel 收平成一块浮层 */}
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

              {/* 底部唯一工具栏（裁剪态压暗让位） */}
              <div className={`${styles.fsToolbarWrap}${cropMode ? ` ${styles.fsToolbarWrapDim}` : ""}`}>
                <ImageToolbar
                  preview={preview}
                  activePanel={activePanel}
                  onPanel={setActivePanel}
                  codeCount={imageBarcodes.hits.length}
                  onCopyImage={() => void handleCopyImage()}
                />
              </div>
              {ocrLoading && <div className={styles.fsOcrWorking}>正在识别文字…</div>}
            </motion.div>
          </FocusTrap>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
