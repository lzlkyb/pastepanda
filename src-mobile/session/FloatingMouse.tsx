import { MousePointer2 } from "lucide-react";
import { useFloatingMouse } from "./useFloatingMouse";
import styles from "./FloatingMouse.module.css";

export function FloatingMouse({ visible, surfaceRef, point, move, reveal, cancel, dragging, scrolling, onClick, onDrag }: {
  visible: boolean;
  surfaceRef: React.RefObject<HTMLElement | null>;
  point: () => { clientX: number; clientY: number } | null;
  move: (dx: number, dy: number) => void;
  reveal: () => void;
  cancel: () => void;
  dragging: boolean;
  scrolling: boolean;
  onClick: (button: 1 | 2) => void;
  onDrag: () => void;
}) {
  const { rootRef, handleRef } = useFloatingMouse({ enabled: visible, surfaceRef, point, move, reveal, cancel });
  return <div ref={rootRef} className={styles.root} hidden={!visible} aria-label="浮动鼠标">
    <button ref={handleRef} type="button" className={styles.handle} aria-label="拖动鼠标控制柄" onClick={reveal}>
      <MousePointer2 size={22} aria-hidden="true" />
      <span>{scrolling ? "滚动" : "移动"}</span>
    </button>
    <div className={styles.actions}>
      <button type="button" disabled={dragging || scrolling} onClick={() => onClick(1)}>左键</button>
      <button type="button" disabled={dragging || scrolling} onClick={() => onClick(2)}>右键</button>
      <button type="button" aria-pressed={dragging} onClick={onDrag}>{dragging ? "释放拖拽" : "拖拽"}</button>
    </div>
  </div>;
}
