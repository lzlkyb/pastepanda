/**
 * RcFsHint — 非全屏时画面区内的轻提示（案 A）。
 *
 * 非 modal、不抢操作；主按钮「全屏」= 已有 toggleFullscreen；「知道了」session 级关闭。
 * 判据在 `lib/rcFsHint.ts`；这里只负责测量（ResizeObserver）与渲染。
 */
import { useEffect, useState } from "react";
import { fsHintCopy, shouldShowFsHint } from "@/lib/rcFsHint";
import styles from "./RemoteComputer.module.css";

export function RcFsHint({
  canControl,
  hasFrame,
  fullscreen,
  dismissed,
  contentSize,
  canvasRef,
  screenRef,
  onFullscreen,
  onDismiss,
}: {
  canControl: boolean;
  hasFrame: boolean;
  fullscreen: boolean;
  dismissed: boolean;
  /** 远端内容逻辑尺寸（useRcFrames 的 size），变化时要重判 */
  contentSize: { w: number; h: number };
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  screenRef: React.RefObject<HTMLDivElement | null>;
  onFullscreen: () => void;
  onDismiss: () => void;
}) {
  const [m, setM] = useState({ stageH: 0, displayW: 0, displayH: 0 });

  useEffect(() => {
    const measure = () => {
      const stage = screenRef.current;
      const canvas = canvasRef.current;
      const cr = canvas?.getBoundingClientRect();
      setM({
        stageH: stage?.clientHeight ?? 0,
        displayW: cr?.width ?? 0,
        displayH: cr?.height ?? 0,
      });
    };
    measure();
    const stage = screenRef.current;
    const ro = new ResizeObserver(measure);
    if (stage) ro.observe(stage);
    if (canvasRef.current) ro.observe(canvasRef.current);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [screenRef, canvasRef, hasFrame, fullscreen, contentSize.w, contentSize.h]);

  const show = shouldShowFsHint({
    fullscreen,
    dismissed,
    hasFrame,
    stageH: m.stageH,
    contentW: contentSize.w,
    contentH: contentSize.h,
    displayW: m.displayW,
    displayH: m.displayH,
  });
  if (!show) return null;
  const copy = fsHintCopy(canControl);
  return (
    <div className={styles.fsHint} role="status">
      <div className={styles.fsHintTxt}>
        {copy.title}
        <small>{copy.sub}</small>
      </div>
      <button type="button" className={styles.fsHintBtn} onClick={onFullscreen}>
        全屏
      </button>
      <button
        type="button"
        className={styles.fsHintGhost}
        title="本会话不再提示"
        onClick={onDismiss}
      >
        知道了
      </button>
    </div>
  );
}
