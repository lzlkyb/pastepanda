import { MousePointer2 } from "lucide-react";
import styles from "./RcMobileSession.module.css";

export function MouseAssist({
  visible,
  padOpen,
  dragging,
  scrolling,
  padRef,
  onClick,
  onDrag,
  onScroll,
}: {
  visible: boolean;
  padOpen: boolean;
  dragging: boolean;
  scrolling: boolean;
  padRef: React.RefObject<HTMLDivElement | null>;
  onClick: (button: 1 | 2) => void;
  onDrag: () => void;
  onScroll: () => void;
}) {
  return (
    <section className={styles.mouseAssist} data-pad-open={padOpen} hidden={!visible} aria-label="鼠标辅助">
      <div className={styles.mouseActions}>
        <button type="button" disabled={dragging} onClick={() => onClick(1)}>
          左键
        </button>
        <button type="button" disabled={dragging} onClick={() => onClick(2)}>
          右键
        </button>
        <button type="button" aria-pressed={dragging} onClick={onDrag}>
          {dragging ? "释放拖拽" : "拖拽"}
        </button>
        <button type="button" aria-pressed={scrolling} onClick={onScroll}>
          滚动
        </button>
      </div>
      <div ref={padRef} className={styles.trackpad} hidden={!padOpen}>
        <MousePointer2 size={22} aria-hidden="true" />
        <span>
          {dragging ? "划动拖拽 · 点释放拖拽结束" : scrolling ? "划动滚动 · 点滚动退出" : "划动移动指针 · 点按左键"}
        </span>
      </div>
    </section>
  );
}
