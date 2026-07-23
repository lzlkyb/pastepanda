/**
 * ImagePreviewDialog — 图片预览弹窗（从 CardList.tsx 提取）
 *
 * 包含：缩放/旋转/平移、OCR 文字识别叠加层与框选、
 * 复制/另存按钮、快捷键提示。
 */
import { motion, AnimatePresence } from "framer-motion";
import { X, ZoomIn, ZoomOut, RotateCw, Copy, Download, ScanText, Pin } from "lucide-react";
import { FocusTrap } from "@/components/FocusTrap";
import { useToast } from "@/components/Toast";
import { getImageBase64, dataUrlToBlob } from "@/lib/api";
import type { UseImagePreviewReturn } from "@/hooks/useImagePreview";
import styles from "./CardList.module.css";

export interface ImagePreviewDialogProps {
  preview: UseImagePreviewReturn;
}

export function ImagePreviewDialog({ preview }: ImagePreviewDialogProps) {
  const { toast } = useToast();
  const {
    previewImage, previewInfo, previewLoading,
    previewScale, previewRotation, previewOffset, isPanning,
    previewContentRef, viewportRef,
    ocrResult, ocrLoading, ocrActive, selectedWordIndices, isSelecting, selRect,
    closePreview, setPreviewScale, setPreviewRotation, setPreviewOffset, setSelectedWordIndices,
    handlePreviewWheel, handlePanStart, handlePanMove, handlePanEnd,
    toggleOcrOverlay, getSelectedOcrTexts, handleOcrWordClick,
    handleOcrSelectStart, handleOcrSelectMove, handleOcrSelectEnd,
    handlePinImage,
  } = preview;

  return (
    <AnimatePresence>
      {(previewImage || previewLoading) && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="dialog-backdrop" style={{ zIndex: 60 }} onClick={closePreview}
        >
          <FocusTrap>
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 20 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            className={`dialog-box ${styles.imageDetailDialog}`}
            onClick={(e) => e.stopPropagation()}
          >
          {/* Header */}
          <div className="dialog-header">
            <h2 className="dialog-title">🖼 图片详情</h2>
            <button onClick={closePreview} className="dialog-close"><X size={16} /></button>
          </div>

          {/* Body */}
          <div className={`dialog-body ${styles.imageDetailBody}`}>
            {/* 元信息标签行 */}
            {previewInfo && (
              <div className={styles.imageDetailMeta}>
                <span className={`${styles.imageDetailTag} ${styles.imageDetailTagAccent}`}>📄 {previewInfo.file_name}</span>
                <span className={styles.imageDetailTag}>{previewInfo.width} × {previewInfo.height}</span>
                <span className={styles.imageDetailTag}>{previewInfo.size_str}</span>
                <span className={styles.imageDetailTag}>来自剪贴板</span>
              </div>
            )}

            {/* 工具栏 */}
            <div className={styles.imageDetailToolbar}>
              <button className={styles.imageDetailToolBtn} title="缩小" onClick={() => setPreviewScale((s) => Math.max(0.2, s - 0.25))}><ZoomOut size={16} /></button>
              <span className={styles.imageDetailZoomLabel}>{Math.round(previewScale * 100)}%</span>
              <button className={styles.imageDetailToolBtn} title="放大" onClick={() => setPreviewScale((s) => Math.min(5, s + 0.25))}><ZoomIn size={16} /></button>
              <button className={styles.imageDetailToolBtn} title="重置为 100% 并居中" onClick={() => { setPreviewScale(1); setPreviewOffset({ x: 0, y: 0 }); }}>1:1</button>
              <button className={styles.imageDetailToolBtn} title="旋转" onClick={() => setPreviewRotation((r) => (r + 90) % 360)}><RotateCw size={16} /></button>
              <span className={styles.imageDetailToolbarSep} />
              {/* OCR 识别按钮 */}
              <button
                className={`${styles.imageDetailToolBtn} ${styles.ocrToolBtn}${ocrActive ? ' ' + styles.ocrToolBtnActive : ''}`}
                title={ocrActive ? "关闭文字识别" : "识别图片中的文字"}
                onClick={toggleOcrOverlay}
                disabled={ocrLoading}
              >
                {ocrLoading ? <div className={styles.ocrSpinnerSmall} /> : <ScanText size={16} />}
                <span style={{ marginLeft: 4, fontSize: 12 }}>{ocrActive ? '文字已识别' : '识别文字'}</span>
              </button>
              {/* 置顶按钮 */}
              <button
                className={`${styles.imageDetailToolBtn} ${styles.pinToolBtn}`}
                title="将图片钉在屏幕最上层"
                onClick={handlePinImage}
              >
                <Pin size={16} />
                <span style={{ marginLeft: 4, fontSize: 12 }}>置顶</span>
              </button>
              <span className={styles.imageDetailToolbarHint}>
                滚轮平移 · Ctrl+滚轮缩放 · 拖拽平移 · 0 重置 · R 旋转
              </span>
            </div>

            {/* 图片查看区 */}
            <div
              ref={viewportRef}
              className={styles.imageDetailViewport}
              onWheel={handlePreviewWheel}
              onMouseDown={ocrActive ? handleOcrSelectStart : handlePanStart}
              onMouseMove={ocrActive ? handleOcrSelectMove : handlePanMove}
              onMouseUp={ocrActive ? handleOcrSelectEnd : handlePanEnd}
              onMouseLeave={ocrActive ? handleOcrSelectEnd : handlePanEnd}
              style={{
                cursor: ocrActive ? (isSelecting ? 'crosshair' : 'text') : isPanning ? "grabbing" : previewScale > 1 ? "grab" : "default",
                position: 'relative',
              }}
            >
              {/* OCR 加载遮罩 */}
              {ocrLoading && (
                <div className={styles.imageDetailLoading}>
                  <div className={styles.imageDetailSpinner} />
                  <span>正在识别文字…</span>
                </div>
              )}
              {previewLoading && !ocrLoading ? (
                <div className={styles.imageDetailLoading}>
                  <div className={styles.imageDetailSpinner} />
                  <span>加载中…</span>
                </div>
              ) : previewImage ? (
                <>
                  <img
                    src={previewImage}
                    alt="预览"
                    className={styles.imageDetailImg}
                    style={{
                      transform: `translate(${previewOffset.x}px, ${previewOffset.y}px) scale(${previewScale}) rotate(${previewRotation}deg)`,
                      transition: isPanning ? "none" : "transform 0.35s cubic-bezier(0.25, 0.46, 0.45, 0.94)",
                    }}
                    draggable={false}
                  />
                  {/* OCR 文字叠加层 */}
                  {ocrActive && ocrResult && (
                    <div className={styles.ocrOverlayContainer} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                      {(() => {
                        const viewport = viewportRef.current;
                        const imgEl = viewport?.querySelector('img') as HTMLImageElement | null;
                        let baseLeft = 0, baseTop = 0, unitX = 0, unitY = 0;
                        if (imgEl && imgEl.naturalWidth && imgEl.naturalHeight) {
                          const imgRect = imgEl.getBoundingClientRect();
                          const vpRect = viewport?.getBoundingClientRect();
                          if (vpRect && vpRect.width > 0 && vpRect.height > 0) {
                            const scaleX = imgRect.width / imgEl.naturalWidth;
                            const scaleY = imgRect.height / imgEl.naturalHeight;
                            baseLeft = ((imgRect.left - vpRect.left) / vpRect.width) * 100;
                            baseTop = ((imgRect.top - vpRect.top) / vpRect.height) * 100;
                            unitX = (scaleX / vpRect.width) * 100;
                            unitY = (scaleY / vpRect.height) * 100;
                          }
                        }
                        return ocrResult.lines.map((line, li) =>
                          line.words.map((word, wi) => {
                            const key = `${li}-${wi}`;
                            const selected = selectedWordIndices.has(key);
                            const left = baseLeft + word.x * unitX;
                            const top = baseTop + word.y * unitY;
                            const width = word.width * unitX;
                            const height = word.height * unitY;
                            return (
                              <div
                                key={key}
                                data-ocr-word-box
                                className={`${styles.ocrWordBox}${selected ? ' ' + styles.ocrWordSelected : ''}`}
                                style={{
                                  position: 'absolute',
                                  left: `${left}%`,
                                  top: `${top}%`,
                                  width: `${width}%`,
                                  height: `${height}%`,
                                  border: selected ? '1.5px solid rgba(16,185,129,0.8)' : '1px solid rgba(99,102,241,0.35)',
                                  background: selected ? 'rgba(16,185,129,0.18)' : 'rgba(99,102,241,0.06)',
                                  borderRadius: 2,
                                  pointerEvents: 'auto',
                                  cursor: 'pointer',
                                  zIndex: selected ? 2 : 1,
                                }}
                                onClick={(e) => handleOcrWordClick(li, wi, e)}
                                title={word.text}
                              />
                            );
                          })
                        );
                      })()}
                      {/* 框选矩形 */}
                      {isSelecting && selRect && (
                        <div style={{
                          position: 'absolute',
                          left: selRect.x,
                          top: selRect.y,
                          width: selRect.w,
                          height: selRect.h,
                          border: '1px dashed #6366f1',
                          background: 'rgba(99,102,241,0.1)',
                          pointerEvents: 'none',
                          zIndex: 10,
                        }} />
                      )}
                    </div>
                  )}
                </>
              ) : null}
            </div>

            {/* OCR 选中结果栏 */}
            {ocrActive && ocrResult && (
              <div className={styles.ocrResultBar}>
                <span style={{ fontSize: 14 }}>🔍</span>
                <span className={styles.ocrResultCount}>
                  已选 <strong>{selectedWordIndices.size}</strong> 个词
                </span>
                <span className={styles.ocrResultPreview}>
                  {selectedWordIndices.size > 0
                    ? getSelectedOcrTexts().join(' ')
                    : '点击图片上的文字区域选择，或拖拽框选'}
                </span>
                {selectedWordIndices.size > 0 && (
                  <button
                    className={styles.ocrResultClearBtn}
                    onClick={() => setSelectedWordIndices(new Set())}
                  >
                    清除
                  </button>
                )}
                <button
                  className={styles.ocrResultCopyBtn}
                  disabled={selectedWordIndices.size === 0}
                  onClick={() => {
                    const texts = getSelectedOcrTexts();
                    if (texts.length === 0) return;
                    navigator.clipboard.writeText(texts.join(' ')).then(() => {
                      toast("已复制选中文字", "success");
                    }).catch(() => toast("复制失败", "error"));
                  }}
                >
                  📋 复制选中
                </button>
              </div>
            )}

            {/* OCR 纯文本结果面板（关闭叠加层时显示） */}
            {!ocrActive && ocrResult && (
              <div className={styles.ocrFullTextPanel}>
                <div className={styles.ocrFullTextHeader}>
                  <span>🔍 全部识别文字</span>
                  <button
                    className={styles.ocrFullTextCopyBtn}
                    onClick={() => {
                      navigator.clipboard.writeText(ocrResult.full_text).then(() => {
                        toast("已复制全部文字", "success");
                      }).catch(() => toast("复制失败", "error"));
                    }}
                  >
                    📋 全部复制
                  </button>
                </div>
                <div className={styles.ocrFullTextBody}>
                  {ocrResult.full_text}
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="dialog-footer">
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
              <button className="btn-primary" style={{ padding: "6px 14px", fontSize: 12 }} onClick={async () => {
                try {
                  const dataUrl = await getImageBase64(previewContentRef.current!);
                  const blob = await dataUrlToBlob(dataUrl);
                  const mimeType = blob.type || "image/png";
                  await navigator.clipboard.write([new ClipboardItem({ [mimeType]: blob })]);
                  toast("已复制", "success");
                } catch { toast("复制失败", "error"); }
              }}><Copy size={14} /> 复制</button>
              <button className="btn-secondary" style={{ padding: "6px 14px", fontSize: 12 }} onClick={async () => {
                try {
                  const { save } = await import("@tauri-apps/plugin-dialog");
                  const { invoke } = await import("@tauri-apps/api/core");
                  const defaultName = String(previewInfo?.file_name || "image.png");
                  const path = await save({ defaultPath: defaultName, filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }] });
                  if (path && previewContentRef.current) {
                    await invoke("save_image_file", { source: previewContentRef.current, dest: path });
                    toast("已保存", "success");
                  }
                } catch { toast("保存失败", "error"); }
              }}><Download size={14} /> 另存</button>
            </div>
            <span className={styles.imageDetailHint} style={{ marginLeft: 16 }}>
              {ocrActive ? '点击选词 · 拖拽框选 · Ctrl+C复制' : '滚轮平移 · Ctrl+滚轮缩放 · +/- 缩放 · 0 重置 · R 旋转'}
            </span>
          </div>
        </motion.div>
        </FocusTrap>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
