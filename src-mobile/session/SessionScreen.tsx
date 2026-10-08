import type { RefObject } from "react";
import { PinchViewport, type PinchViewportHandle } from "../video/PinchViewport";
import { VideoSurface } from "../video/VideoSurface";
import { FloatingMouse } from "./FloatingMouse";
import { RemoteCursorGlyph } from "./RemoteCursorGlyph";
import type { useRemoteCursor } from "./useRemoteCursor";
import type { useSessionPointer } from "./useSessionPointer";
import { SessionFrameState, SessionModeNotice } from "./SessionScreenNotices";
import type { RcConnectStage } from "./rcConnectStage";
import styles from "./RcMobileSession.module.css";

export function SessionScreen({ pointer, canControl, hasFrame, statusText, waitHint, stage, onReturn, blocked,
  canvasRef, surfaceRef, viewportRef, cursorRef, chargeRef, remoteCursorRef, remoteShape, sandboxSize,
}: {
  pointer: ReturnType<typeof useSessionPointer>;
  canControl: boolean;
  hasFrame: boolean;
  statusText?: string;
  waitHint?: string;
  stage?: RcConnectStage | null;
  onReturn: () => void;
  blocked: boolean;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  surfaceRef: RefObject<HTMLDivElement | null>;
  viewportRef: RefObject<PinchViewportHandle | null>;
  cursorRef: RefObject<HTMLDivElement | null>;
  chargeRef: RefObject<HTMLDivElement | null>;
  remoteCursorRef: RefObject<HTMLDivElement | null>;
  remoteShape: ReturnType<typeof useRemoteCursor>["shape"];
  sandboxSize?: { w: number; h: number };
}) {
  return <div className={styles.screenArea}>
    <PinchViewport ref={viewportRef} surfaceRef={surfaceRef}>
      <VideoSurface canvasRef={canvasRef} className={styles.canvas} statusText={statusText} showStatus={false} sandboxSize={sandboxSize} />
    </PinchViewport>
    {!hasFrame && <SessionFrameState text={statusText} hasFrame={hasFrame} hint={waitHint} stage={stage} onReturn={onReturn} />}
    {!statusText && <SessionModeNotice hasFrame={hasFrame} canControl={canControl} pointer={pointer} />}
    <div ref={cursorRef} className={styles.cursorRing} aria-hidden="true" />
    <div ref={chargeRef} className={styles.chargeRing} aria-hidden="true" />
    <div ref={remoteCursorRef} className={styles.remoteCursor} aria-hidden="true"><RemoteCursorGlyph shape={remoteShape} /></div>
    {pointer.mode === "floating" && <FloatingMouse visible={canControl && hasFrame && !statusText && !blocked}
      surfaceRef={surfaceRef} point={pointer.point} move={pointer.moveFloating} reveal={pointer.reveal} cancel={pointer.reset}
      dragging={pointer.dragging} scrolling={pointer.scrolling} onClick={pointer.click} onDrag={pointer.toggleDrag} />}
  </div>;
}
