import { MousePointer2 } from "lucide-react";
import { useFloatingMouse } from "./useFloatingMouse";
import styles from "./FloatingMouse.module.css";
import { MouseButtons } from "./MouseButtons";

export function FloatingMouse({ visible, surfaceRef, point, move, reveal, cancel, dragging, scrolling, clickEnabled, onClick, onDrag, onScroll }: {
  visible: boolean;
  surfaceRef: React.RefObject<HTMLElement | null>;
  point: () => { clientX: number; clientY: number } | null;
  move: (dx: number, dy: number) => void;
  reveal: () => void;
  cancel: () => void;
  dragging: boolean;
  scrolling: boolean;
  clickEnabled: boolean;
  onClick: (button: 1 | 2) => void;
  onDrag: () => void;
  onScroll: () => void;
}) {
  const { rootRef, handleRef } = useFloatingMouse({ enabled: visible, surfaceRef, point, move, reveal, cancel });
  return <div ref={rootRef} className={styles.root} hidden={!visible} aria-label="浮动鼠标">
    <button ref={handleRef} type="button" className={styles.handle} aria-label="拖动鼠标控制柄" onClick={reveal}>
      <MousePointer2 size={22} aria-hidden="true" />
      <span>{scrolling ? "滚动" : "移动"}</span>
    </button>
    <MouseButtons className={styles.actions} clickEnabled={clickEnabled} dragging={dragging}
      scrolling={scrolling} onClick={onClick} onDrag={onDrag} onScroll={onScroll} />
  </div>;
}
