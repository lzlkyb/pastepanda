import { clamp, constrainAnchors, moveAnchors, ropeDrop } from "./physics.mjs";

export function installGestures({
  stage,
  hangs,
  left,
  right,
  mover,
  marker,
  hint,
  getState,
  getGeometry,
  getCurve,
  onAnchors,
  onAnchorCommit,
  onDetach,
  onTransferEnd,
  onReorder,
  onPreview,
  onInteraction,
  onFinish,
  onGeometryCancel,
  onSlotPreview,
  onError,
  coach,
}) {
  let drag = null;
  const zoom = () => parseFloat(stage.style.getPropertyValue("--zoom")) || 1;
  const point = (event) => {
    const r = stage.getBoundingClientRect();
    return { x: (event.clientX - r.left) / zoom(), y: (event.clientY - r.top) / zoom() };
  };
  function hide() {
    marker.hidden = true;
    hint.hidden = true;
    onSlotPreview(null, null);
  }
  function begin(event, el, kind, id = null) {
    if (event.button !== 0 || drag) return;
    const state = getState();
    // 原生接收与大风吹走是整根绳的事，仍然全局挡。
    if (state.nativeReceiving || state.clearing) return;
    // 取挂是逐张事务：只挡「这一张」自己。旧版拿 taking.size / pendingHangs.size /
    // pins.some(pending) 当条件，一张图在途就把整根绳的拖动全锁死——而且这里不是
    // disabled，是直接 return，按钮亮着却拖不动、连提示都没有。
    if (
      id !== null &&
      (state.taking?.has(id) ||
        state.clearingIds.has(id) ||
        state.pendingHangs.has(id) ||
        state.pins.some((p) => p.item.id === id && (p.pending || p.pendingBack)))
    )
      return;
    // 端点与整绳拖动和单张取挂正交，只避开锁定与批量收衣（与 runtime 的 geometryBusy 同口径）。
    if (kind !== "card" && (state.locked || state.collecting)) return;
    drag = {
      el,
      kind,
      id,
      pointerId: event.pointerId,
      start: point(event),
      point: point(event),
      anchors: structuredClone(state.anchors),
      geometry: structuredClone(getGeometry()),
      curve: [...getCurve()],
      custom: state.custom,
      x: parseFloat(el.style.left) || 0,
      y: parseFloat(el.style.top) || 0,
      moved: false,
      slot: null,
      detached: false,
      // 教学计数在「第一次真正显示落点」时才扣，不能写在 pointerdown 里：
      // 单击一张照片也会走 begin()（松手不移就开预览），三次点击就能把
      // 三次教学机会全吃掉，用户真正开始拖时反而什么都不显示了。
      coach: null,
    };
    try { el.setPointerCapture(event.pointerId); }
    catch (error) { drag = null; onError?.(error); return; }
    onInteraction(true);
  }
  function finishDrag(cancelled = false, handedOff = false) {
    if (!drag) return null;
    const active = drag;
    active.held = false;
    active.cancelled ||= cancelled;
    drag = null;
    hide();
    active.el.classList.remove("dragging");
    if (!active.handoff || cancelled || handedOff) active.el.classList.remove("unclipped");
    if (active.el.hasPointerCapture(active.pointerId)) active.el.releasePointerCapture(active.pointerId);
    onInteraction(false);
    if (active.handoff && !handedOff) onTransferEnd?.(cancelled, active.id);
    if (cancelled) {
      if (["left", "right", "whole"].includes(active.kind)) onGeometryCancel(active.anchors);

      onFinish();
    }
    return active;
  }
  function cancelDrag() {
    finishDrag(true);
  }
  function slotAt(p, geometry, ignoreId) {
    const cards = geometry.cards.filter((c) => c.item.id !== ignoreId);
    const index = cards.findIndex((c) => p.x < c.x);
    return index < 0 ? cards.length : index;
  }
  // 教学文案是否显示：整次拖动只判定一次（coach 会递减计数，不能每帧调）。
  function coachAllowed() {
    if (drag.coach === null) drag.coach = coach?.() ?? true;
    return drag.coach;
  }
  function showSlot(p, geometry, ignoreId, label) {
    const cards = geometry.cards.filter((c) => c.item.id !== ignoreId),
      slot = slotAt(p, geometry, ignoreId);
    const projected = onSlotPreview(drag.id, slot);
    const x =
      projected?.x ??
      (cards.length
        ? slot === 0
          ? cards[0].x - cards[0].width / 2
          : slot === cards.length
            ? cards.at(-1).x + cards.at(-1).width / 2
            : (cards[slot - 1].x + cards[slot].x) / 2
        : (geometry.left + geometry.right) / 2);
    const y = ropeDrop(geometry, getCurve(), x).y;
    const width = projected?.width ?? 100;
    marker.style.width = width + "px";
    marker.style.height = (projected?.height ?? 70) + "px";
    marker.style.left = clamp(x - width / 2, geometry.left, geometry.right - width) + "px";
    marker.style.top = y + 6 + "px";
    marker.hidden = false;
    hint.textContent = label;
    hint.hidden = !coachAllowed();
    return slot;
  }
  function move(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const p = point(event),
      dx = p.x - drag.start.x,
      dy = p.y - drag.start.y;
    drag.point = p;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    drag.el.classList.add("dragging");
    const state = getState(),
      g = getGeometry();
    if (drag.kind === "left" || drag.kind === "right") {
      const next = structuredClone(drag.anchors);
      next[drag.kind] = { x: drag.anchors[drag.kind].x + dx, y: drag.anchors[drag.kind].y + dy };
      onAnchors(constrainAnchors(next, drag.kind, state.width, state.height));
      return;
    }
    if (drag.kind === "whole") {
      onAnchors(moveAnchors(drag.anchors, dx, dy, state.width, state.height));
      return;
    }
    drag.el.style.left = drag.x + dx + "px";
    drag.el.style.top = drag.y + dy + "px";
    const center = { x: drag.x + dx, y: drag.y + dy },
      contact = ropeDrop(drag.geometry, drag.curve, center.x);
    if (drag.handoff) {
      if (center.x >= g.left && center.x <= g.right && Math.abs(center.y - contact.y) <= 24) cancelDrag();
      return;
    }
    drag.detached = center.x < g.left - 24 || center.x > g.right + 24 || Math.abs(center.y - contact.y) > 36;
    drag.el.classList.toggle("unclipped", drag.detached);
    if (drag.detached) {
      // 解码期间仍由浏览器跟手；原生接收确认后才释放捕获，避免悬空的交接帧。
      const active = drag;
      active.handoff = true;
      active.held = true;
      hide();
      onDetach(active.id, active.el, true, true, {
        cancel: () => {
          if (active.cancelled) return;
          if (drag === active) cancelDrag();
          else { active.cancelled = true; onTransferEnd?.(true, active.id); onFinish(); }
        },
        release: () => {
          const held = active.held;
          if (drag === active) finishDrag(false, true);
          active.el.classList.remove("unclipped");
          return { held, cancelled: !!active.cancelled, point: active.point };
        },
      });
    } else drag.slot = showSlot(center, g, drag.id, "松手调整顺序 · 拉离绳带取下");
  }
  function up(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    // Mouse-up can carry the last movement frame; commit its position, not the previous move.
    move(event);
    if (!drag) return;
    const active = finishDrag();
    if (active.handoff) return;
    if (["left", "right", "whole"].includes(active.kind)) {
      if (active.moved) onAnchorCommit(active.anchors, active.custom);
      else onFinish();
      return;
    }

    if (!active.moved) {
      onPreview(active.id);
      return;
    }
    if (active.detached) onDetach(active.id, active.el, true);
    else if (active.slot !== null) onReorder(active.id, active.slot);
    else onFinish();
  }
  for (const [el, kind] of [
    [left, "left"],
    [right, "right"],
    [mover, "whole"],
  ])
    el.onpointerdown = (e) => begin(e, el, kind);
  hangs.onpointerdown = (e) => {
    const el = e.target.closest(".hang");
    if (el && !e.target.closest("button")) begin(e, el, "card", el.dataset.id);
  };

  for (const el of [hangs, left, right, mover]) {
    el.onpointermove = move;
    el.onpointerup = up;
    el.onpointercancel = (event) => {
      if (drag && event.pointerId === drag.pointerId) cancelDrag();
    };
    el.onlostpointercapture = (event) => {
      if (drag && event.pointerId === drag.pointerId && event.target === drag.el) cancelDrag();
    };
  }
  return { cancelDrag, isDragging: () => !!drag, draggedId: () => (drag?.kind === "card" ? drag.id : null) };
}
