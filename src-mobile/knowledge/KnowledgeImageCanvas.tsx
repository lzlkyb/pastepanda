import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { PinchViewport, type PinchViewportHandle } from "../video/PinchViewport";
import { useTouchGestures } from "../session/useTouchGestures";
import { PINCH_MAX } from "../session/touchConstants";
import { MobileNotice } from "../ui/MobileNotice";
import ui from "../ui/MobileUi.module.css";
import styles from "./KnowledgeImageCanvas.module.css";

/** Image-only local gestures. Neither panning nor a pinch can dismiss the containing sheet. */
export type ImageCanvasHandle = { zoom: (ratio: number) => void; reset: () => void };
export const KnowledgeImageCanvas = forwardRef<ImageCanvasHandle, { src: string; alt: string; onFailure: (failed: boolean) => void }>(function KnowledgeImageCanvas({ src, alt, onFailure }, ref) {
  const surface = useRef<HTMLElement>(null);
  const viewport = useRef<PinchViewportHandle>(null);
  const contentSize = useRef({w:0,h:0});
  const last = useRef({ x: 0, y: 0 });
  const [failed, setFailed] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const noop = () => {};
  const pinch = (ratio: number, dx: number, dy: number, x: number, y: number) => {
    const current = viewport.current?.getScale() || 1;
    viewport.current?.applyPinch(Math.max(1, Math.min(PINCH_MAX, current * ratio)) / current, dx, dy, x, y);
  };
  const pan = (x: number, y: number) => {
    if ((viewport.current?.getScale() || 1) > 1) pinch(1, x - last.current.x, y - last.current.y, x, y);
    last.current = { x, y };
  };
  useTouchGestures({ surfaceRef: surface, enabled: !failed, longPress: false, onDown: (x, y) => { last.current = { x, y }; }, callbacks: {
    onTap: noop, onCharge: noop, onChargeCancel: noop, onRightClick: noop, onDragStart: noop, onDragEnd: noop,
    onMoveTo: pan,
    onDragMove: pan, onScrollDelta: (dx, dy, x, y) => pinch(1, dx, dy, x, y), onPinchStart: noop, onPinchUpdate: pinch,
  } });
  const zoom = (ratio: number) => {
    const rect = surface.current?.getBoundingClientRect();
    if (rect) pinch(ratio, 0, 0, rect.left + rect.width / 2, rect.top + rect.height / 2);
  };
  useImperativeHandle(ref, () => ({ zoom, reset: () => viewport.current?.reset() }));
  return <div className={styles.root} data-error={failed}>
    <div className={styles.canvas} hidden={failed}>
      <PinchViewport ref={viewport} surfaceRef={surface} contentSize={contentSize}>
        <img key={epoch} className={styles.image} src={src} alt={alt || "笔记图片"} draggable={false} onLoad={event => {
          contentSize.current = {w:event.currentTarget.naturalWidth,h:event.currentTarget.naturalHeight}; viewport.current?.reset(); onFailure(false);
        }} onError={() => { setFailed(true); onFailure(true); }} />
      </PinchViewport>
    </div>
    {failed && <MobileNotice compact error title="图片未能打开" detail="正文仍保留，可重新读取图片。" action={<button className={ui.textButton} onClick={() => { setFailed(false); onFailure(false); setEpoch(v => v + 1); }}>重新读取</button>} />}
    {!failed && <p className={styles.hint}>双指缩放，放大后拖动</p>}
  </div>;
});
