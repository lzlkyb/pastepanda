/**
 * 让 CodeMirror 查找/替换面板变成可拖动的悬浮卡片。
 *
 * 面板 DOM 由 @codemirror/search 在打开时插入：
 *   .cm-editor > .cm-panels > .cm-panel.cm-search
 * 位置由 globals.css 默认贴在编辑器右上；这里只负责「按住空白处拖走」，
 * 拖动后把 CSS 的 right 定位切成 left/top，并夹在编辑器可视区内。
 *
 * 不在输入框 / 按钮 / 开关胶囊上启动拖动，避免抢焦点和误触。
 */
export function attachSearchPanelDrag(editorRoot: HTMLElement): () => void {
  let dragging = false;
  let pointerId = -1;
  let startX = 0;
  let startY = 0;
  let origLeft = 0;
  let origTop = 0;

  const panelOf = () =>
    editorRoot.querySelector(".cm-panel.cm-search") as HTMLElement | null;

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement | null;
    if (!t) return;
    // 控件不参与拖动：输入框、按钮、开关、关闭键
    if (t.closest("input, button, label")) return;
    const panel = t.closest(".cm-panel.cm-search") as HTMLElement | null;
    if (!panel || !editorRoot.contains(panel)) return;

    const host = panel.closest(".cm-editor") as HTMLElement | null;
    if (!host) return;

    const hostRect = host.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    dragging = true;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    origLeft = panelRect.left - hostRect.left;
    origTop = panelRect.top - hostRect.top;

    // 首次拖动：从 right 定位切换到 left/top，后续才能累加位移
    panel.style.left = `${origLeft}px`;
    panel.style.top = `${origTop}px`;
    panel.style.right = "auto";
    panel.classList.add("cm-search-dragging");
    try {
      panel.setPointerCapture(e.pointerId);
    } catch {
      /* 捕获失败不致命，move/up 仍挂在 root 上 */
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!dragging || e.pointerId !== pointerId) return;
    const panel = panelOf();
    if (!panel) {
      dragging = false;
      return;
    }
    const host = panel.closest(".cm-editor") as HTMLElement | null;
    if (!host) return;

    const hostRect = host.getBoundingClientRect();
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    let left = origLeft + (e.clientX - startX);
    let top = origTop + (e.clientY - startY);
    left = Math.max(0, Math.min(left, Math.max(0, hostRect.width - w)));
    top = Math.max(0, Math.min(top, Math.max(0, hostRect.height - h)));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  };

  const endDrag = (e: PointerEvent) => {
    if (!dragging || e.pointerId !== pointerId) return;
    dragging = false;
    pointerId = -1;
    panelOf()?.classList.remove("cm-search-dragging");
  };

  editorRoot.addEventListener("pointerdown", onPointerDown);
  editorRoot.addEventListener("pointermove", onPointerMove);
  editorRoot.addEventListener("pointerup", endDrag);
  editorRoot.addEventListener("pointercancel", endDrag);

  return () => {
    editorRoot.removeEventListener("pointerdown", onPointerDown);
    editorRoot.removeEventListener("pointermove", onPointerMove);
    editorRoot.removeEventListener("pointerup", endDrag);
    editorRoot.removeEventListener("pointercancel", endDrag);
  };
}
