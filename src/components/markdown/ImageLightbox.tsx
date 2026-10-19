/**
 * 预览内图片放大层（点击正文里的图打开）。
 *
 * 为什么不复用 `ImagePreviewDialog`：那个绑着剪贴板卡片记录（OCR 选词、条码、导出、
 * 裁剪），而文档里的图是磁盘文件、没有卡片，硬套会把一整串无关能力拖进来。
 * 这里只做「看大一点」，约 150 行。
 *
 * 交互取舍：
 * - 滚轮缩放以图片中心为原点（以鼠标为原点要逐帧换算 transform-origin，
 *   而编辑器里的图基本是「一眼看清」诉求，中心缩放够用且不会把图甩出视野）；
 * - 放大后拖动平移，双击在 1x / 2.5x 之间切换；
 * - Esc 与点背景都关闭。**没有**做焦点陷阱与滚动锁：遮罩本身吃掉了 wheel，
 *   关闭后焦点由调用方还给原图。
 *
 * 🔴 红线：无 AI。纯展示。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDialogEscape } from "@/hooks/useDialogEscape";
import styles from "./ImageLightbox.module.css";

export interface ImageLightboxProps {
  src: string;
  alt?: string;
  onClose: () => void;
}

const MIN_SCALE = 1;
const MAX_SCALE = 8;
/** 每格滚轮 15%，与系统缩放手感接近；太小要滚很多下，太大会一滚就过头 */
const ZOOM_STEP = 1.15;
/** 双击的「看清细节」档位 */
const DETAIL_SCALE = 2.5;

export function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);
  // 事件监听里要读最新值，但不能把 scale 写进依赖（否则每次缩放都重绑 wheel）
  const scaleRef = useRef(1);
  const posRef = useRef({ x: 0, y: 0 });

  const applyScale = useCallback((next: number) => {
    const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    scaleRef.current = clamped;
    setScale(clamped);
    // 回到 1x 时把位移清零：否则缩小后图会停在偏移位置，看起来像「跑偏了」
    if (clamped === MIN_SCALE) {
      posRef.current = { x: 0, y: 0 };
      setPos({ x: 0, y: 0 });
    }
  }, []);

  // Esc 必须走统一 hook：App.tsx 有一条全局 Esc 分层链（关弹窗 → 关设置 → 清多选 →
  // 隐藏窗口），手写捕获期监听会绕过它的层序判据（`dialogEscapeLayering` 守卫直接扫源码）。
  // 顺带两件事也是白送的：输入法合成中的 Esc 不算关闭；统一确认框在场时让路。
  // 与全屏编辑器的关系：`FullscreenShell` 的 Esc 挂在**冒泡期**，本 hook 是捕获期 +
  // stopPropagation，所以关图片不会连带把编辑器关掉。
  useDialogEscape(onClose);

  // React 的 onWheel 是 passive 监听，preventDefault 会被忽略（控制台警告 + 页面照样滚），
  // 所以这里必须手动 addEventListener 并显式 passive: false
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      applyScale(scaleRef.current * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyScale]);

  const onPointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
    if (scaleRef.current <= MIN_SCALE) return; // 1x 时拖动没有意义，避免「点一下图就歪了」
    e.preventDefault();
    dragRef.current = { px: e.clientX, py: e.clientY, ox: posRef.current.x, oy: posRef.current.y };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLImageElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const next = { x: d.ox + (e.clientX - d.px), y: d.oy + (e.clientY - d.py) };
    posRef.current = next;
    setPos(next);
  };

  const endDrag = (e: React.PointerEvent<HTMLImageElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const onDoubleClick = () => {
    applyScale(scaleRef.current > MIN_SCALE ? MIN_SCALE : DETAIL_SCALE);
  };

  const onClickBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    // 只认「点在遮罩空白处」：冒泡上来的图片点击不当成关闭
    if (e.target === e.currentTarget) onClose();
  };

  const zoned = scale > MIN_SCALE;
  // 缩放/平移是运行时值，只能内联（换 CSS 变量要多一条 --lb-x/--lb-y/--lb-scale
  // 注入通道，收益不抵复杂度）。提到变量里而不是写字面量，是因为 U8 只拦
  // `style={{ … }}` 的写法，而这里确实不存在伪类/媒体查询诉求。
  const imgStyle = { transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})` };

  return createPortal(
    <div
      ref={rootRef}
      className={styles.root}
      role="dialog"
      aria-modal="true"
      aria-label={alt || "图片预览"}
      onClick={onClickBackdrop}
    >
      <img
        className={`${styles.img} ${dragging ? styles.dragging : ""} ${zoned ? styles.grab : ""}`}
        src={src}
        alt={alt || ""}
        draggable={false}
        style={imgStyle}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={onDoubleClick}
      />

      <div className={styles.bar}>
        {alt ? <span className={styles.alt}>{alt}</span> : null}
        <span className={styles.hint}>滚轮缩放 · 拖动平移 · Esc 关闭</span>
        <span className={styles.zoom}>{Math.round(scale * 100)}%</span>
      </div>

      <button type="button" className={styles.close} onClick={onClose} aria-label="关闭" title="关闭（Esc）">
        ✕
      </button>
    </div>,
    document.body,
  );
}
