/** All pointer modes use the hook's click guard; scrolling never also sends a click. */
export function MouseButtons({ className, clickEnabled, dragging, scrolling, onClick, onDrag, onScroll }: {
  className: string;
  clickEnabled: boolean;
  dragging: boolean;
  scrolling: boolean;
  onClick: (button: 1 | 2) => void;
  onDrag: () => void;
  onScroll: () => void;
}) {
  return <div className={className}>
    <button type="button" disabled={!clickEnabled} onClick={() => onClick(1)}>左键</button>
    <button type="button" disabled={!clickEnabled} onClick={() => onClick(2)}>右键</button>
    <button type="button" aria-pressed={dragging} onClick={onDrag}>{dragging ? "释放拖拽" : "拖拽"}</button>
    <button type="button" aria-pressed={scrolling} onClick={onScroll}>{scrolling ? "退出滚动" : "滚动"}</button>
  </div>;
}
