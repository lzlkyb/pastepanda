/**
 * ImagePreviewDialog — 图片预览弹窗（从 CardList.tsx 提取）
 *
 * 包含：缩放/旋转/平移、OCR 文字识别叠加层与框选、
 * 复制/另存按钮、快捷键提示。
 */
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, ZoomIn, ZoomOut, RotateCw, Copy, Download, ScanText, Pin, FileDown, Scissors, Check, RotateCcw } from "lucide-react";
import { FocusTrap } from "@/components/FocusTrap";
import { useDialogAnim } from "@/lib/dialogMotion";
import { useToast } from "@/components/Toast";
import { useDialogStore } from "@/stores/dialogStore";
import { useAppStore } from "@/stores/appStore";
import { copyToClipboard, extractEntities, type OcrEntity, type OcrEntityType } from "@/lib/utils";
import {
  EXPORT_FORMATS,
  EXPORT_FORMAT_ORDER,
  formatBytes,
  type ExportFormat,
} from "@/lib/imageFormat";
import type { UseImagePreviewReturn } from "@/hooks/useImagePreview";
import styles from "./CardList.module.css";
import { useModalScrollLock } from "@/contexts/ScrollContext";

export interface ImagePreviewDialogProps {
  preview: UseImagePreviewReturn;
}

export function ImagePreviewDialog({ preview }: ImagePreviewDialogProps) {
  const { toast } = useToast();
  const anim = useDialogAnim();
  // 打开弹框时暂停主窗口 Lenis 平滑滚动，避免弹框内滚轮穿透到底层列表（dialog.css .dialog-backdrop 另加 overscroll-behavior:contain 兜底原生链）
  useModalScrollLock();
  const {
    previewImage, previewInfo, previewLoading,
    previewScale, previewRotation, previewOffset, isPanning,
    previewContentRef, viewportRef, previewItem,
    ocrResult, ocrLoading, ocrActive, selectedWordIndices, isSelecting, selRect,
    exportFormat, exportQuality, exportEstimate, exporting,
    cropMode, cropRect, cropOriginal,
    closePreview, setPreviewScale, setPreviewRotation, setPreviewOffset, setSelectedWordIndices,
    setExportFormat, setExportQuality, exportImage,
    toggleCropMode,
    handleCropMouseDown, handleCropMouseMove, handleCropMouseUp,
    confirmCrop, cancelCrop, restoreOriginal,
    handlePreviewWheel, handlePanStart, handlePanMove, handlePanEnd,
    toggleOcrOverlay, getSelectedOcrTexts, getSelectedOcrJoined, handleOcrWordClick,
    handleOcrSelectStart,
    handlePinImage,
  } = preview;

  // OCR 结果可编辑 + 复制反馈本地状态
  const [ocrEditText, setOcrEditText] = useState("");
  const [ocrEditing, setOcrEditing] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);
  const [copiedSel, setCopiedSel] = useState(false);
  // A方案③ OCR 折叠抽屉：默认收起（一条），点开上滑全文/校对/下一步
  const [ocrDrawerOpen, setOcrDrawerOpen] = useState(false);
  // A方案④ 导出并入 footer：导出浮层开合
  const [exportOpen, setExportOpen] = useState(false);
  // 微信借鉴① 实体 popover：{ type, value, 相对结果面板的 x/y }；popFeedback 为按钮内联反馈
  const [entityPop, setEntityPop] = useState<{ type: OcrEntityType; value: string; x: number; y: number } | null>(null);
  const [popFeedback, setPopFeedback] = useState<string | null>(null);
  useEffect(() => {
    if (ocrResult?.full_text) {
      setOcrEditText(ocrResult.full_text);
      setOcrEditing(false);
      setOcrDrawerOpen(true); // 识别完成自动展开一次，便于直接阅读/复制
    }
  }, [ocrResult?.full_text]);

  // ===== 微信借鉴① 实体高亮渲染：把全文按 extractEntities 切分，URL/电话/邮箱渲染为可点击 span =====
  const fullPanelRef = useRef<HTMLDivElement | null>(null);
  const renderOcrText = (text: string): React.ReactNode[] => {
    const entities = extractEntities(text);
    if (entities.length === 0) return [text];
    const nodes: React.ReactNode[] = [];
    let cursor = 0;
    entities.forEach((ent, i) => {
      if (ent.start > cursor) nodes.push(text.slice(cursor, ent.start));
      const cls =
        ent.type === "url" ? styles.ocrEntityUrl
        : ent.type === "phone" ? styles.ocrEntityPhone
        : styles.ocrEntityEmail;
      nodes.push(
        <span
          key={i}
          className={`${styles.ocrEntity} ${cls}`}
          onClick={(e) => openEntityPopover(e, ent)}
        >
          {ent.value}
        </span>
      );
      cursor = ent.end;
    });
    if (cursor < text.length) nodes.push(text.slice(cursor));
    return nodes;
  };

  const openEntityPopover = (e: React.MouseEvent, ent: OcrEntity) => {
    e.stopPropagation();
    const panel = fullPanelRef.current;
    if (!panel) return;
    const pr = panel.getBoundingClientRect();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // 尽量放在实体下方；接近面板底部时翻到上方，避免浮层出面板被裁
    const below = r.bottom - pr.top + 6;
    const top = below + 150 > pr.height ? r.top - pr.top - 156 : below;
    setEntityPop({ type: ent.type, value: ent.value, x: r.left - pr.left, y: top });
    setPopFeedback(null);
  };

  const closeEntityPopover = () => setEntityPop(null);

  /** 存为卡片：走 appStore.prependItem（纯本地，零出网；id 用项目惯例 crypto.randomUUID） */
  const saveOcrAsCard = (text: string) => {
    const t = text.trim();
    if (!t) return;
    const store = useAppStore.getState();
    store.prependItem({
      id: crypto.randomUUID(),
      text: t,
      time: new Date().toISOString(),
      type: "text",
      content: "",
      pinned: false,
      source: "OCR",
      workspace: store.config.current_workspace,
    });
    toast("已存为卡片", "success");
  };

  const handleEntityAction = async (action: "copy" | "open" | "save") => {
    if (!entityPop) return;
    const { type, value } = entityPop;
    if (action === "copy") {
      const ok = await copyToClipboard(value);
      if (ok) {
        setPopFeedback("已复制 ✓");
        setTimeout(closeEntityPopover, 900);
      } else toast("复制失败", "error");
    } else if (action === "open") {
      try {
        // 本地识别 + 用户主动，符合隐私红线；file:// 无此场景，直接 openUrl
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        if (type === "url") await openUrl(value);
        else if (type === "phone") await openUrl(`tel:${value.replace(/[\s-]/g, "")}`);
        else await openUrl(`mailto:${value}`);
        closeEntityPopover();
      } catch {
        toast("打开失败", "error");
      }
    } else {
      saveOcrAsCard(value);
      closeEntityPopover();
    }
  };

  // 微信借鉴③ 按需点亮：未选词时搜索置灰，选中后才可点（仿微信搜一搜）
  const handleSearchSelected = async () => {
    const q = getSelectedOcrJoined();
    if (!q) return;
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(`https://www.bing.com/search?q=${encodeURIComponent(q)}`);
    } catch {
      toast("打开搜索失败", "error");
    }
  };

  // 微信借鉴② 工具栏「翻译」→ 交给变换枢纽（复用 openHub，不重复造轮子）
  const handleTranslateAll = () => {
    if (!previewItem) return;
    const text = ocrEditing ? ocrEditText : (ocrResult?.full_text ?? "");
    const item = previewItem;
    closePreview();
    useDialogStore.getState().openHub(item, text);
  };

  const handleCopyAll = async () => {
    const ok = await copyToClipboard(ocrEditing ? ocrEditText : (ocrResult?.full_text ?? ""));
    if (ok) {
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1500);
    } else toast("复制失败", "error");
  };

  // 裁剪拖拽：mousedown 在 overlay 上触发，move/up 挂在 window 上以便拖出视口仍能跟踪。
  useEffect(() => {
    if (!cropMode) return;
    const onMove = (e: MouseEvent) => {
      handleCropMouseMove(e as unknown as React.MouseEvent);
    };
    const onUp = () => handleCropMouseUp();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        confirmCrop();
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

  return (
    <AnimatePresence>
      {(previewImage || previewLoading) && (
        <motion.div
          {...anim.backdrop}
          className="dialog-backdrop" onClick={closePreview}
        >
          <FocusTrap>
          <motion.div
            {...anim.panel}
            className={`dialog-box ${styles.imageDetailDialog}`}
            onClick={(e) => e.stopPropagation()}
          >
          {/* Header */}
          <div className="dialog-header">
            <h2 className="dialog-title">🖼 图片详情</h2>
            <button onClick={closePreview} className="dialog-close"><X size={16} /></button>
          </div>

          {/* Body */}
          <div className={`dialog-body ${styles.imageDetailBody}`} onClick={closeEntityPopover}>
            {/* 元信息标签行 */}
            {previewInfo && (
              <div className={styles.imageDetailMeta}>
                <span className={`${styles.imageDetailTag} ${styles.imageDetailTagAccent}`}>📄 {previewInfo.file_name}</span>
                <span className={styles.imageDetailTag}>{previewInfo.width} × {previewInfo.height}</span>
                <span className={styles.imageDetailTag}>{previewInfo.size_str}</span>
                <span className={styles.imageDetailTag}>来自剪贴板</span>
              </div>
            )}

            {/* 图片查看区（A方案：工具栏悬浮其上，不占正文行） */}
            {/* 结构解耦：stage 不裁切，toolbar 移到视口外，避免被 overflow:hidden 裁掉 */}
            <div className={styles.imageDetailStage}>
              {/* A方案② 悬浮胶囊工具条（已移出 overflow:hidden 视口，按内容自然加宽） */}
              <div className={styles.imageDetailToolbar}>
                <button className={styles.imageDetailToolBtn} title="缩小" onClick={() => setPreviewScale((s) => Math.max(0.2, s - 0.25))}><ZoomOut size={14} /></button>
                <span className={styles.imageDetailZoomLabel}>{Math.round(previewScale * 100)}%</span>
                <button className={styles.imageDetailToolBtn} title="放大" onClick={() => setPreviewScale((s) => Math.min(5, s + 0.25))}><ZoomIn size={14} /></button>
                <button className={styles.imageDetailToolBtn} title="重置为 100% 并居中" onClick={() => { setPreviewScale(1); setPreviewOffset({ x: 0, y: 0 }); }}>1:1</button>
                <button className={styles.imageDetailToolBtn} title="旋转" onClick={() => setPreviewRotation((r) => (r + 90) % 360)}><RotateCw size={14} /></button>
                <span className={styles.imageDetailToolbarSep} />
                {/* OCR 识别按钮 */}
                <button
                  className={`${styles.imageDetailToolBtn} ${styles.ocrToolBtn}${ocrActive ? ' ' + styles.ocrToolBtnActive : ''}`}
                  title={ocrActive ? "关闭文字识别" : "识别图片中的文字"}
                  onClick={toggleOcrOverlay}
                  disabled={ocrLoading}
                >
                  {ocrLoading ? <div className={styles.ocrSpinnerSmall} /> : <ScanText size={14} />}
                  <span style={{ marginLeft: 3, fontSize: 11 }}>{ocrActive ? '文字已识别' : '识别文字'}</span>
                </button>
                {/* 置顶按钮 */}
                <button
                  className={`${styles.imageDetailToolBtn} ${styles.pinToolBtn}`}
                  title="将图片钉在屏幕最上层"
                  onClick={handlePinImage}
                >
                  <Pin size={14} />
                  <span style={{ marginLeft: 3, fontSize: 11 }}>置顶</span>
                </button>
                {/* 裁剪按钮（与 OCR 选词互斥，见 toggleCropMode：进裁剪自动退出选词） */}
                <button
                  className={`${styles.imageDetailToolBtn} ${styles.cropToolBtn} ${cropMode ? styles.imageDetailToolBtnActive : ''}`}
                  title="进入/退出裁剪模式"
                  onClick={() => {
                    toggleCropMode();
                  }}
                >
                  <Scissors size={14} />
                  <span style={{ marginLeft: 3, fontSize: 11 }}>裁剪</span>
                </button>
              </div>
            <div
              ref={viewportRef}
              className={styles.imageDetailViewport}
              onWheel={handlePreviewWheel}
              onMouseDown={ocrActive ? handleOcrSelectStart : handlePanStart}
              /* A+B：框选的 move/up 已由 window 级监听接管（拖出视口不中断）；
                 这里仅非 OCR 态（平移）保留 viewport 级 move/up/leave */
              onMouseMove={ocrActive ? undefined : handlePanMove}
              onMouseUp={ocrActive ? undefined : handlePanEnd}
              onMouseLeave={ocrActive ? undefined : handlePanEnd}
              style={{
                cursor: ocrActive ? (isSelecting ? 'crosshair' : 'text') : isPanning ? "grabbing" : previewScale > 1 ? "grab" : "default",
                position: 'relative',
              }}
            >
              {/* A方案：模式提示浮标（图片左下角） */}
              <div className={styles.imageDetailToolbarHint} style={{ position: 'absolute', bottom: 8, left: 10, marginLeft: 0 }}>
                {ocrActive ? '点击选词 · 拖拽框选' : '滚轮平移 · Ctrl+滚轮缩放 · 0 重置 · R 旋转'}
              </div>
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
                  {/* A：图片 + OCR 词框共用一个 transform 容器 —— 词框用 OCR 返回的图片像素坐标，
                      缩放/平移/旋转/动画全程与图片同步，彻底消除"图层对不上"（不再 getBoundingClientRect 反算） */}
                  <div
                    className={styles.imageDetailTransform}
                    style={{
                      transform: `translate(${previewOffset.x}px, ${previewOffset.y}px) scale(${previewScale}) rotate(${previewRotation}deg)`,
                      transition: isPanning ? "none" : "transform 0.35s cubic-bezier(0.25, 0.46, 0.45, 0.94)",
                    }}
                  >
                    <img
                      src={previewImage}
                      alt="预览"
                      className={styles.imageDetailImg}
                      draggable={false}
                    />
                    {/* OCR 文字叠加层：与 img 同容器，词框直接用图片像素坐标。
                        ⚠️ cropMode 时不渲染：词框 pointerEvents:auto 且 z-index 高于裁剪层，
                        叠加会拦掉点在词框上的裁剪 mousedown（互斥逻辑见 toggleCropMode，这里双保险）。 */}
                    {ocrActive && ocrResult && !cropMode && (
                      <div className={styles.ocrOverlayContainer} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                        {ocrResult.lines.map((line, li) =>
                          line.words.map((word, wi) => {
                            const key = `${li}-${wi}`;
                            const selected = selectedWordIndices.has(key);
                            return (
                              <div
                                key={key}
                                data-ocr-word-box
                                data-key={key}
                                className={`${styles.ocrWordBox}${selected ? ' ' + styles.ocrWordSelected : ''}`}
                                style={{
                                  position: 'absolute',
                                  left: word.x,
                                  top: word.y,
                                  width: word.width,
                                  height: word.height,
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
                        )}
                      </div>
                    )}
                  </div>
                  {/* 框选矩形：视口坐标（与词框容器分离，避免随 transform 漂移） */}
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
                  {/* 裁剪叠加层 */}
                  {cropMode && previewImage && !previewLoading && (
                    <>
                      <div
                        className={styles.cropBackdrop}
                        onMouseDown={(e) => handleCropMouseDown(e)}
                        style={{ cursor: 'crosshair' }}
                      />
                      {cropRect && (
                        <>
                          <div className={styles.cropMask} style={{ top: 0, left: 0, right: 0, height: cropRect.y }} />
                          <div className={styles.cropMask} style={{ bottom: 0, left: 0, right: 0, height: `calc(100% - ${cropRect.y + cropRect.h}px)` }} />
                          <div className={styles.cropMask} style={{ top: cropRect.y, left: 0, width: cropRect.x, height: cropRect.h }} />
                          <div className={styles.cropMask} style={{ top: cropRect.y, right: 0, width: `calc(100% - ${cropRect.x + cropRect.w}px)`, height: cropRect.h }} />
                          <div
                            className={styles.cropSel}
                            style={{ left: cropRect.x, top: cropRect.y, width: cropRect.w, height: cropRect.h }}
                          >
                            <div className={styles.cropGridH} style={{ top: '33.333%' }} />
                            <div className={styles.cropGridH} style={{ top: '66.667%' }} />
                            <div className={styles.cropGridV} style={{ left: '33.333%' }} />
                            <div className={styles.cropGridV} style={{ left: '66.667%' }} />
                            {(['tl','tc','tr','ml','mr','bl','bc','br'] as const).map((name) => (
                              <div
                                key={name}
                                className={`${styles.cropHandle}${name.length === 2 && !name.includes('c') ? ' ' + styles.cropHandleCorner : ''}`}
                                style={
                                  name === 'tl' ? { left: -5, top: -5, cursor: 'nwse-resize' }
                                  : name === 'tc' ? { left: '50%', top: -5, cursor: 'ns-resize', transform: 'translateX(-50%)' }
                                  : name === 'tr' ? { right: -5, top: -5, cursor: 'nesw-resize' }
                                  : name === 'ml' ? { left: -5, top: '50%', cursor: 'ew-resize', transform: 'translateY(-50%)' }
                                  : name === 'mr' ? { right: -5, top: '50%', cursor: 'ew-resize', transform: 'translateY(-50%)' }
                                  : name === 'bl' ? { left: -5, bottom: -5, cursor: 'nesw-resize' }
                                  : name === 'bc' ? { left: '50%', bottom: -5, cursor: 'ns-resize', transform: 'translateX(-50%)' }
                                  : { right: -5, bottom: -5, cursor: 'nwse-resize' }
                                }
                              />
                            ))}
                            <div className={styles.cropHintBar}>
                              <span>{Math.round(cropRect.w)} × {Math.round(cropRect.h)}</span>
                            </div>
                          </div>
                        </>
                      )}
                      {cropOriginal && (
                        <button
                          className={styles.cropRestoreBtn}
                          onClick={(e) => { e.stopPropagation(); restoreOriginal(); }}
                          title="还原原图"
                        >
                          <RotateCcw size={13} />
                          <span style={{ marginLeft: 4, fontSize: 11 }}>还原原图</span>
                        </button>
                      )}
                    </>
                  )}
                </>
              ) : null}
            </div>
            </div>

            {/* 裁剪确认/取消栏 */}
            {cropMode && (
              <div className={styles.cropActionBar}>
                <span className={styles.cropActionHint}>
                  拖拽绘制选区 · 拖动手柄调整 · Enter 确认
                </span>
                <button
                  className={styles.cropActionBtn}
                  onClick={confirmCrop}
                  disabled={!cropRect || cropRect.w < 10 || cropRect.h < 10}
                >
                  <Check size={14} />
                  <span style={{ marginLeft: 4 }}>确认裁剪</span>
                </button>
                <button
                  className={styles.cropActionBtnSecondary}
                  onClick={cancelCrop}
                >
                  取消
                </button>
              </div>
            )}

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
                  onClick={async () => {
                    const texts = getSelectedOcrTexts();
                    if (texts.length === 0) return;
                    const ok = await copyToClipboard(texts.join(' '));
                    if (ok) {
                      setCopiedSel(true);
                      setTimeout(() => setCopiedSel(false), 1500);
                    } else {
                      toast("复制失败", "error");
                    }
                  }}
                >
                  {copiedSel ? "✓ 已复制" : "📋 复制选中"}
                </button>
                {/* 把选中的文字交给变换枢纽，而不是在这里再搭一套动作列表。
                    两处各维护一份动作迟早会漂，而且自定义动作还得同步两遍。 */}
                <button
                  className={styles.ocrResultGhostBtn}
                  disabled={selectedWordIndices.size === 0}
                  title="拿选中的文字去翻译 / 解释 / 自定义动作（选中词后可用）"
                  onClick={() => {
                    const texts = getSelectedOcrTexts();
                    if (texts.length === 0 || !previewItem) return;
                    const item = previewItem;
                    closePreview();
                    useDialogStore.getState().openHub(item, texts.join(' '));
                  }}
                >
                  ✨ 变换为…
                </button>
                {/* 微信借鉴③ 按需点亮：未选词置灰、选中词后亮起（仿微信搜一搜） */}
                <button
                  className={styles.ocrResultGhostBtn}
                  disabled={selectedWordIndices.size === 0}
                  title="拿选中的文字去搜索（选中词后可用）"
                  onClick={handleSearchSelected}
                >
                  🔍 搜索
                </button>
                {/* 选词态也保留「全部复制」，免去先关叠加层 */}
                <button
                  className={styles.ocrResultCopyBtn}
                  onClick={async () => {
                    const ok = await copyToClipboard(ocrResult?.full_text ?? "");
                    if (ok) {
                      setCopiedAll(true);
                      setTimeout(() => setCopiedAll(false), 1500);
                    } else {
                      toast("复制失败", "error");
                    }
                  }}
                >
                  {copiedAll ? "✓ 已复制" : "📋 全部复制"}
                </button>
              </div>
            )}

            {/* OCR 折叠抽屉（A方案③：默认一条，点开上滑全文/校对/下一步） */}
            {ocrResult && (
              <div className={`${styles.ocrFullTextPanel}${ocrDrawerOpen ? ' ' + styles.ocrDrawerOpen : ''}`} ref={fullPanelRef}>
                <button
                  className={styles.ocrDrawerHead}
                  onClick={() => setOcrDrawerOpen((v) => !v)}
                  title={ocrDrawerOpen ? "收起识别结果" : "展开识别结果"}
                >
                  <span style={{ fontSize: 12 }}>🔍</span>
                  <span className={styles.ocrDrawerTitle}>全部识别文字</span>
                  <span className={styles.ocrDrawerCount}>
                    {ocrResult.lines.length} 行 · {ocrResult.lines.reduce((n, l) => n + l.text.length, 0)} 字
                  </span>
                  <div className={styles.ocrFullTextActions} onClick={(e) => e.stopPropagation()}>
                    <button
                      className={styles.ocrFullTextEditToggle}
                      onClick={() => setOcrEditing((v) => !v)}
                    >
                      {ocrEditing ? "完成" : "可编辑"}
                    </button>
                    <button
                      className={styles.ocrFullTextCopyBtn}
                      onClick={handleCopyAll}
                    >
                      {copiedAll ? "✓ 已复制" : "📋 全部复制"}
                    </button>
                  </div>
                  <span className={styles.ocrDrawerChev} style={{ transform: ocrDrawerOpen ? 'rotate(180deg)' : 'none' }}>▾</span>
                </button>

                {ocrDrawerOpen && (
                  <div className={styles.ocrDrawerBody}>
                    {/* 微信借鉴② 下一步动作工具栏（收敛一组，替代零散按钮） */}
                    <div className={styles.ocrActionToolbar}>
                      <span className={styles.ocrActionLabel}>下一步</span>
                      <button
                        className={`${styles.ocrActionBtn} ${styles.ocrActionBtnPrimary}`}
                        onClick={handleCopyAll}
                      >
                        📋 复制全部
                      </button>
                      <button
                        className={styles.ocrActionBtn}
                        title="把识别文字存为一条新卡片（纯本地）"
                        onClick={() => saveOcrAsCard(ocrEditing ? ocrEditText : (ocrResult.full_text ?? ""))}
                      >
                        💾 存为卡片
                      </button>
                      <button
                        className={styles.ocrActionBtn}
                        title="拿识别文字去变换枢纽（翻译 / 总结 / 改写）"
                        onClick={handleTranslateAll}
                      >
                        ✨ 翻译
                      </button>
                      <button
                        className={styles.ocrActionBtn}
                        disabled={selectedWordIndices.size === 0}
                        title="拿选中的文字去搜索（选中词后可用）"
                        onClick={handleSearchSelected}
                      >
                        🔍 搜索
                      </button>
                    </div>

                    {ocrEditing ? (
                      /* 微信借鉴④ 校对模式：左原图缩略、右可编辑文本对照改错（仿微信电脑端右侧面板） */
                      <div className={styles.ocrProofPanel}>
                        <div className={styles.ocrProofThumb}>
                          {previewImage && <img src={previewImage} alt="原图对照" />}
                        </div>
                        <textarea
                          className={styles.ocrProofEdit}
                          value={ocrEditText}
                          onChange={(e) => setOcrEditText(e.target.value)}
                          spellCheck={false}
                        />
                      </div>
                    ) : (
                      <div className={styles.ocrFullTextBody}>
                        {renderOcrText(ocrResult.full_text)}
                      </div>
                    )}

                    {/* 微信借鉴① 实体 popover（本地识别 + 用户主动动作，符合隐私红线） */}
                    {entityPop && (
                      <div
                        className={styles.ocrEntityPop}
                        style={{ left: entityPop.x, top: entityPop.y }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className={styles.ocrEntityPopTitle}>
                          {entityPop.type === "url" ? "🔗 链接" : entityPop.type === "phone" ? "📞 电话" : "✉️ 邮箱"}
                        </div>
                        <div className={styles.ocrEntityPopValue}>{entityPop.value}</div>
                        <button className={styles.ocrEntityPopBtn} onClick={() => handleEntityAction("copy")}>
                          {popFeedback || "⧉ 复制"}
                        </button>
                        {entityPop.type === "url" && (
                          <button className={styles.ocrEntityPopBtn} onClick={() => handleEntityAction("open")}>
                            ↗ 打开链接
                          </button>
                        )}
                        {entityPop.type === "phone" && (
                          <button className={styles.ocrEntityPopBtn} onClick={() => handleEntityAction("open")}>
                            📞 呼叫
                          </button>
                        )}
                        {entityPop.type === "email" && (
                          <button className={styles.ocrEntityPopBtn} onClick={() => handleEntityAction("open")}>
                            ✉️ 发邮件
                          </button>
                        )}
                        <button className={styles.ocrEntityPopBtn} onClick={() => handleEntityAction("save")}>
                          💾 存为卡片
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* A方案④ 导出并入 footer：导出浮层（格式/质量/预估） */}
            {previewImage && !previewLoading && exportOpen && (
              <div className={styles.imageExportPop}>
                <div className={styles.imageExportRow} style={{ border: 'none', borderRadius: 0 }}>
                  <span className={styles.imageExportLabel}>导出</span>
                  <div className={styles.imageExportSeg}>
                    {EXPORT_FORMAT_ORDER.map((f) => (
                      <button
                        key={f}
                        className={`${styles.imageExportSegBtn}${exportFormat === f ? ' ' + styles.imageExportSegBtnActive : ''}`}
                        onClick={() => setExportFormat(f as ExportFormat)}
                      >
                        {EXPORT_FORMATS[f].label}
                      </button>
                    ))}
                  </div>
                  <div className={styles.imageExportQuality}>
                    <input
                      type="range"
                      min={10}
                      max={100}
                      step={1}
                      value={Math.round(exportQuality * 100)}
                      disabled={!EXPORT_FORMATS[exportFormat].lossy}
                      onChange={(e) => setExportQuality(Number(e.target.value) / 100)}
                      className={styles.imageExportSlider}
                    />
                    <span>{Math.round(exportQuality * 100)}%</span>
                  </div>
                  <span className={styles.imageExportEstimate}>
                    ≈ {exportEstimate != null ? formatBytes(exportEstimate) : "…"}
                  </span>
                  <button
                    className={styles.imageExportBtn}
                    onClick={exportImage}
                    disabled={exporting || !previewImage}
                  >
                    <FileDown size={14} />
                    {exporting ? "导出中…" : "导出"}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="dialog-footer">
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
              <button className="btn-primary" style={{ padding: "6px 14px", fontSize: 12 }} onClick={async () => {
                try {
                  const { copyImageOnly } = await import("@/lib/api");
                  await copyImageOnly(previewContentRef.current!);
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
              {/* A方案④ 导出并入 footer：点开浮层选格式/质量 */}
              {previewImage && !previewLoading && (
                <button
                  className="btn-ghost"
                  style={{ padding: "6px 14px", fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4, border: "1px solid var(--border-color)", borderRadius: 6, background: "transparent", color: "var(--text-secondary)", cursor: "pointer", fontFamily: "inherit", transition: "all .15s" }}
                  onClick={() => setExportOpen((v) => !v)}
                  title="格式转换 + 压缩"
                >
                  <FileDown size={14} />
                  导出{exportOpen ? " ▴" : ""}
                </button>
              )}
            </div>
            <span className={styles.imageDetailHint} style={{ marginLeft: 16 }}>
              {ocrActive ? '点击选词 · 拖拽框选' : '滚轮平移 · Ctrl+滚轮缩放 · 0 重置 · R 旋转'}
            </span>
          </div>
        </motion.div>
        </FocusTrap>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
