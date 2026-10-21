import {
  layout,
  equilibrium,
  springProgress,
  springImpulse,
  sample,
  clamp,
  defaultAnchors,
  constrainAnchors,
  moveAnchors,
  ropePoint,
  ropeDrop,
  canSettle,
  insertAtSlot,
} from "./physics.mjs";
import { createEffects } from "./effects.mjs";
import { installGestures } from "./gestures.mjs";
import { createQueue } from './queue.mjs';
import { createOriginalCache } from './originalCache.mjs';

export async function mountClothesline(bridge) {
  const lifecycle = new AbortController();
  let disposed = false;
  let initialized = false;
  const $ = (id) => document.getElementById(id);
  const systemReduce = matchMedia("(prefers-reduced-motion: reduce)");
  const taking = new Set(),
    cancelledTakes = new Set(),
    loading = new Map();
  const handoffs = new Map();
  const nativeReceivers = new Map();
  const earlyNativeDrops = new Map();
  const awaitingDragAcks = new Set();
  const originals = createOriginalCache(item => bridge.original(item));
  let previewRequest = 0;
  const state = {
    width: window.innerWidth,
    height: window.innerHeight,
    items: [],
    pins: [],
    // 初始值必须与 Rust `Snapshot::default()` 同口径（7.2.12 起默认关）。
    // 窗口只在 enabled 时才会被创建，这里给 false 是为了「关掉后残留页」不先亮一帧绳子。
    enabled: false,
    wind: true,
    locked: false,
    anchors: defaultAnchors(window.innerWidth),
    custom: false,
    clearingIds: new Set(),
    pendingHangs: new Set(),
    taking,
    get nativeReceiving() { return nativeReceivers.size > 0; },
    get clearing() { return !!clearOperation; },
  };
  const cards = new Map();
  const regionCache = new Map();
  let toolbarSize = null;
  const queueView = createQueue($("queue"), id => bridge.safe(takeItem(id)), () => { regionCache.delete('queue'); sendRegions(); });
  let visible = true,
    nextPinSlot = 0,
    collecting = false,
    batchStopped = false,
    idleTimer = 0,
    regionsFrame = 0;
  let geometry,
    target,
    curve,
    frame = 0,
    motion = null,
    windTimer = 0,
    gestures,
    dragging = false,
    nativeDragging = null;
  let nativeRope = null;
  let hovered = false,
    focused = false,
    previewId = null,
    previewAnimation = null,
    returnFocus = null,
    clearOperation = null;
  let toastTimer = 0;
  let waitingSnapshot = null;
  const reduced = () => systemReduce.matches;
  const blocked = () => dragging || hovered || focused || collecting || state.nativeReceiving || handoffs.size > 0 || previewId !== null || !!clearOperation;
  const available = () => state.enabled && visible && !document.hidden && state.items.length > 0 && !reduced();
  const effects = createEffects({
    stage: $("stage"),
    layer: $("fxLayer"),
    reduced: () => reduced() || !visible || document.hidden,
  });

  function photo(item) {
    const box = document.createElement("div");
    box.className = "photo";
    if (item.url) {
      const image = document.createElement("img");
      image.src = item.url;
      image.alt = item.name;
      image.draggable = false;
      image.decoding = "async";
      box.append(image);
    } else {
      const fallback = document.createElement(item.error ? "button" : "div");
      fallback.className = "photoRetry";
      fallback.textContent = item.error ? "图片未能加载 · 点击重试" : "加载图片…";
      if (item.error) fallback.onclick = () => bridge.safe(prepareItems([item], true));
      box.append(fallback);
    }
    return box;
  }
  function resize() {
    toolbarSize = null;
    regionCache.clear();
    state.width = window.innerWidth;
    state.height = window.innerHeight;
    const zoom = 1;
    $("stage").style.setProperty("--sw", state.width + "px");
    $("stage").style.setProperty("--zoom", zoom);
    $("stageWrap").style.width = state.width * zoom + "px";
    $("stageWrap").style.height = state.height * zoom + "px";
  }

  function saveAnchors() {
    const anchors = state.custom
      ? {
          left: { x: state.anchors.left.x / state.width, y: state.anchors.left.y / state.height },
          right: { x: state.anchors.right.x / state.width, y: state.anchors.right.y / state.height },
        }
      : null;
    bridge.safe(bridge.config({ clothesline_anchors: anchors }));
  }
  function applyAnchors(value) {
    state.custom = !!value;
    if (value?.left && value?.right) {
      state.anchors = {
        left: { x: value.left.x * state.width, y: value.left.y * state.height },
        right: { x: value.right.x * state.width, y: value.right.y * state.height },
      };
      state.anchors = constrainAnchors(
        constrainAnchors(state.anchors, "right", state.width, state.height),
        "left",
        state.width,
        state.height,
      );
    } else state.anchors = defaultAnchors(state.width);
  }
  async function prepareItems(items, retry = false) {
    const capacity = Math.min(8, Math.max(1, Math.floor((state.anchors.right.x - state.anchors.left.x + 12) / 126)));
    await Promise.all(
      items.slice(-capacity).map(async (item) => {
        if (item.url && !retry) return;
        if (loading.has(item.id)) return loading.get(item.id);
        const request = (async () => {
          try {
            const prepared = await bridge.prepare(item, retry);
            if (disposed) return;
            Object.assign(item, prepared);
            item.error = null;
          } catch (error) {
            if (disposed) return;
            item.error = String(error);
            toast("图片读取失败，原图保留 · 点击图片可重试");
          }
          const el = cards.get(item.id);
          if (el) {
            el.querySelector(".photo")?.replaceWith(photo(item));
          }
        })();
        loading.set(item.id, request);
        try {
          await request;
        } finally {
          loading.delete(item.id);
        }
      }),
    );
  }
  function sendRegions() {
    if (regionsFrame) return;
    regionsFrame = requestAnimationFrame(() => {
      regionsFrame = 0;
      if (!visible) return;
      const selectors = "#hangs .hang,#anchorLeft,#anchorRight,#moveRope,#ropeToolbar,#toast,#takeProgress,#loupe,#queue";
      const regions = [...document.querySelectorAll(selectors)].filter(el => !el.hidden && el.style.visibility !== 'hidden').map(el => {
        if (el.classList.contains('hang')) {
          // 卡片带 translateX(-50%) + rotate()，按 --iw/--ih 手工拼矩形会漏掉旋转后的四角：
          // 鼠标落在角上不命中 ⇒ 窗口保持穿透 ⇒ 用户点不动。用真实包围盒。
          const r = effects.rect(el);
          return { x: r.x - 8, y: r.y - 8, width: r.w + 16, height: r.h + 16 };
        }
        let r = regionCache.get(el.id);
        if (!r) { r = effects.rect(el); regionCache.set(el.id, r); }
        // Moving controls have explicit stage coordinates; dimensions change only with content/layout.
        const positioned = ['anchorLeft','anchorRight','moveRope','ropeToolbar','queue'].includes(el.id);
        return { x:positioned ? parseFloat(el.style.left) : r.x, y:positioned ? parseFloat(el.style.top) : r.y, width:r.w, height:r.h };
      }).filter(r => r.width > 0 && r.height > 0 && Number.isFinite(r.x) && Number.isFinite(r.y));
      bridge.regions(regions, dragging);
    });
  }
  function queueIdle() {
    clearTimeout(idleTimer);
    if (!state.items.length && !state.nativeReceiving && !state.pins.some((p) => p.pending) && !clearOperation)
      idleTimer = setTimeout(() => bridge.idle(), 4000);
  }
  function renderCards() {
    regionCache.clear();
    const ids = new Set(geometry.cards.map((c) => c.item.id));
    // In-flight handoff still owns pointer capture on its source, even after the rope fills.
    for (const id of taking) ids.add(id);
    if (gestures?.draggedId()) ids.add(gestures.draggedId());
    for (const [id, el] of cards)
      if (!ids.has(id)) {
        el.remove();
        cards.delete(id);
      }
    for (const card of geometry.cards) {
      let el = cards.get(card.item.id);
      if (!el) {
        el = document.createElement("div");
        el.className = "hang";
        el.dataset.id = card.item.id;
        el.tabIndex = 0;
        el.setAttribute("role", "group");
        el.setAttribute("aria-label", "查看 " + card.item.name + "，Enter 打开预览");
        const paper = document.createElement("div");
        paper.className = "frame";
        paper.append(photo(card.item));
        const caption = document.createElement("span");
        caption.className = "caption";
        caption.textContent = "已保存 · " + card.item.name;
        const take = document.createElement("button");
        take.className = "takeOne";
        take.textContent = "取下为贴图";
        take.onclick = () => takeItem(card.item.id);
        paper.append(caption, take);
        el.append(paper);
        $("hangs").append(el);
        cards.set(card.item.id, el);
        if (initialized && !reduced() && !state.pendingHangs.has(card.item.id) && !state.clearingIds.has(card.item.id))
          paper.animate(
            [
              { opacity: 0, transform: "translateY(-24px)" },
              { opacity: 1, transform: "translateY(0)" },
            ],
            { duration: 300, easing: "cubic-bezier(.05,.7,.1,1)" },
          );
      }
      el.style.setProperty("--iw", card.iw + "px");
      el.style.setProperty("--ih", card.ih + "px");
      el.style.visibility =
        state.clearingIds.has(card.item.id) || state.pendingHangs.has(card.item.id) ? "hidden" : "visible";
      const count = card.iw >= 150 ? 2 : 1;
      if (el.querySelectorAll(".clip").length !== count) {
        el.querySelectorAll(".clip").forEach((c) => c.remove());
        for (let i = 0; i < count; i++) {
          const clip = document.createElement("span");
          clip.className = "clip";
          el.prepend(clip);
        }
      }
    }
    $("emptyRope").hidden = state.items.length > 0 || !!clearOperation;
    $("ropeLayer").hidden = !state.enabled;
    // 取挂是逐张事务，只锁「正在处理的那一张」。旧版把 taking.size / pendingHangs /
    // pins.pending 写成全局条件：只要有一张在途，整根绳子的按钮全灰，用户点不动，
    // 而代码只回一句「正在完成取挂，请稍候」。
    $("gather").disabled = !state.enabled || !state.items.length || collecting || !!clearOperation;
    $("clear").disabled = $("gather").disabled;
    for (const [id, el] of cards)
      el.querySelector(".takeOne").disabled =
        state.nativeReceiving ||
        collecting ||
        !!clearOperation ||
        taking.has(id) ||
        state.pendingHangs.has(id) ||
        state.pins.some((p) => p.item.id === id && (p.pending || p.pendingBack));
    // 端点与整绳拖动和照片取挂正交，只避开批量动作与原生接收。
    const geometryBusy = state.nativeReceiving || !!clearOperation || collecting;
    $("restoreAnchors").disabled = state.locked || geometryBusy;
    for (const id of ["anchorLeft", "anchorRight", "moveRope"]) $(id).disabled = state.locked || geometryBusy;
    $("stageStatus").textContent = !state.enabled
      ? "晾衣绳已关闭 · 原有采集照旧"
      : clearOperation
        ? "大风正在吹走 · 可随时撤销"
        : state.items.length + " 张照片 · 拖离取下 / 拖回挂上";
    $("countValue").textContent =
      geometry.cards.length + " 张" + (geometry.queued ? " · " + geometry.queued + " 排队" : "");
    $("sagValue").textContent = Math.max(...target).toFixed(1) + "px";
    $("anchorValue").textContent = ["left", "right"]
      .map((side) => `(${Math.round(state.anchors[side].x)}, ${Math.round(state.anchors[side].y)})`)
      .join(" → ");
    queueView.render(state.items.filter(item => !ids.has(item.id) && !state.clearingIds.has(item.id)), $("gather").disabled);
    toolbarSize = null;
  }
  function draw(values, windAngle = 0) {
    curve = values;
    $("ropePath").setAttribute(
      "d",
      values
        .map((_, i) => {
          const p = ropePoint(geometry, values, i / 64);
          return `${i ? "L" : "M"}${p.x.toFixed(2)},${p.y.toFixed(2)}`;
        })
        .join(" "),
    );
    $("ropeShadow").setAttribute("d", $("ropePath").getAttribute("d"));
    for (const [id, side] of [
      ["anchorLeft", "left"],
      ["anchorRight", "right"],
    ]) {
      const p = state.anchors[side];
      $(id).style.left = p.x - 16 + "px";
      $(id).style.top = p.y - 16 + "px";
    }
    const middle = ropePoint(geometry, values, 0.5);
    $("moveRope").style.left = middle.x - 48 + "px";
    $("moveRope").style.top = Math.max(2, middle.y - 29) + "px";
    for (const card of geometry.cards) {
      const el = cards.get(card.item.id);
      if (!el || (taking.has(card.item.id) && !cancelledTakes.has(card.item.id)) || gestures?.draggedId() === card.item.id) continue;
      const t = (card.x - geometry.left) / geometry.span,
        p = ropePoint(geometry, values, t);
      el.style.left = card.x + "px";
      el.style.top = p.y + "px";
      const clips = [...el.querySelectorAll(".clip")];
      clips.forEach((clip, i) => {
        const fraction = clips.length === 1 ? 0.5 : i ? 0.74 : 0.26,
          ct = (card.x + (fraction - 0.5) * card.width - geometry.left) / geometry.span;
        const y = ropePoint(geometry, values, ct).y,
          slope =
            (ropePoint(geometry, values, ct + 0.002).y - ropePoint(geometry, values, ct - 0.002).y) /
            (0.004 * geometry.span);
        clip.style.left = fraction * 100 + "%";
        clip.style.top = y - p.y - 5 + "px";
        clip.style.setProperty("--tilt", (Math.atan(slope) * 180) / Math.PI + "deg");
      });
      el.style.setProperty(
        "--angle",
        clamp((sample(values, t) - sample(target, t)) * -0.5 + windAngle * Math.sin(Math.PI * t), -5, 5) + "deg",
      );
    }
    const bottom = Math.max(
      state.anchors.left.y,
      state.anchors.right.y,
      ...geometry.cards.map((card) => ropeDrop(geometry, values, card.x).y + card.height),
    );
    const toolbar = $("ropeToolbar"),
      size = toolbarSize || (toolbarSize = { width: toolbar.offsetWidth, height: toolbar.offsetHeight }),
      width = size.width,
      height = size.height;
    toolbar.style.left = clamp(middle.x - width / 2, 16, state.width - width - 16) + "px";
    const below = bottom + 12,
      above = Math.min(state.anchors.left.y, state.anchors.right.y) - height - 12;
    const toolbarTop = below + height < state.height - 16 ? below : Math.max(16, above);
    toolbar.style.top = toolbarTop + "px";
    $("queue").style.left = toolbar.style.left;
    $("queue").style.top = clamp(toolbarTop + height + 8, 100, state.height - 80) + "px";
    sendRegions();
  }
  function stop() {
    cancelAnimationFrame(frame);
    frame = 0;
    motion = null;
    $("motionValue").textContent = "休眠 · 无逐帧更新";
  }
  function scheduleWind() {
    clearTimeout(windTimer);
    windTimer = 0;
    if (available() && state.wind && !blocked()) windTimer = setTimeout(gust, 20000 + Math.random() * 25000);
    $("windStatus").textContent = !state.enabled
      ? "风已停止"
      : reduced()
        ? "减少动态 · 静态反馈"
        : blocked()
          ? "互动中 · 微风暂停"
          : state.wind
            ? "偶发微风 · 20–45 秒"
            : "微风已关闭";
  }
  function animate(now) {
    if (!motion || !state.enabled || !visible || document.hidden) {
      stop();
      return;
    }
    const seconds = (now - motion.start) / 1000;
    if (motion.kind === "spring") {
      if (seconds >= 1.2) {
        draw(target);
        stop();
        scheduleWind();
        return;
      }
      const progress = springProgress(seconds),
        impulse = springImpulse(seconds, motion.kick);
      draw(
        target.map((y, i) => motion.from[i] + (y - motion.from[i]) * progress + impulse * Math.sin((Math.PI * i) / 64)),
      );
    } else {
      if (seconds >= 2.4 || blocked() || reduced()) {
        draw(target);
        stop();
        scheduleWind();
        return;
      }
      const envelope = Math.sin((Math.PI * seconds) / 2.4) ** 2;
      draw(
        target.map(
          (y, i) => y + 3 * envelope * Math.sin((Math.PI * i) / 64) * Math.sin(seconds * 3 + i / 64) * motion.direction,
        ),
        2 * envelope * Math.sin(seconds * 3) * motion.direction,
      );
    }
    frame = requestAnimationFrame(animate);
  }
  function settle(kick = 0, anchorDrag = false) {
    stop();
    clearTimeout(windTimer);
    if (
      !canSettle({
        enabled: state.enabled,
        hidden: document.hidden || !visible,
        reduced: reduced(),
        dragging: dragging && !anchorDrag,
        preview: previewId !== null || !!state.pendingHangs.size,
      })
    ) {
      draw(target);
      scheduleWind();
      return;
    }
    motion = { kind: "spring", from: [...curve], start: performance.now(), kick, anchorDrag };
    $("motionValue").textContent = "弹簧响应 · k130 / c16";
    frame = requestAnimationFrame(animate);
  }
  function update(kick = 0, instant = false) {
    if (disposed) return;
    geometry = layout(state.width, state.items, state.anchors);
    target = equilibrium(geometry);
    curve ||= [...target];
    renderCards();
    draw(instant ? target : curve);
    bridge.safe(prepareItems(state.items));
    if (instant || reduced() || !state.enabled) {
      stop();
      draw(target);
      scheduleWind();
    } else settle(kick);
  }
  function gust() {
    clearTimeout(windTimer);
    if (!available() || blocked()) {
      scheduleWind();
      return;
    }
    stop();
    draw(target);
    motion = { kind: "wind", start: performance.now(), direction: Math.random() < 0.5 ? -1 : 1 };
    $("motionValue").textContent = "短阵风 · 2.4 秒";
    $("windStatus").textContent = "一阵轻风经过";
    frame = requestAnimationFrame(animate);
  }
  function interactionChanged() {
    if ((dragging && !motion?.anchorDrag) || previewId !== null) {
      stop();
    } else if (blocked() && motion?.kind === "wind") {
      stop();
      draw(target);
    }
    scheduleWind();
  }
  function toast(message) {
    if (disposed) return;
    $("toast").textContent = message;
    regionCache.delete('toast');
    $("toast").hidden = false;
    scheduleToastHide();
    sendRegions();
  }
  function scheduleToastHide() {
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastTimer = 0;
      // A pending native read needs continuous feedback, without a polling timer.
      if (state.nativeReceiving) return;
      $("toast").hidden = true;
      sendRegions();
      queueIdle();
    }, 4000);
  }
  function renderPins() {
    $("pins").replaceChildren();
    for (const pin of state.pins) {
      const el = document.createElement("div");
      el.className = "pinGhost";
      el.dataset.pin = pin.key;
      Object.assign(el.style, {
        left: pin.x + "px",
        top: pin.y + "px",
        width: pin.width + "px",
        height: pin.height + "px",
        visibility: "hidden",
      });
      el.append(photo(pin.item));
      $("pins").append(el);
    }
  }
  async function takeItem(id, sourceEl = cards.get(id), dragged = false, batch = false, continuous = false, handoff) {
    const item = state.items.find((i) => i.id === id);
    // 只挡「这一张」自己：同一张图不能同时在取下与挂回里，别的照片互不影响。
    if (
      disposed || !item || !!clearOperation ||
      state.nativeReceiving ||
      state.clearingIds.has(id) ||
      taking.has(id) ||
      state.pins.some((p) => p.item.id === id && (p.pending || p.pendingBack)) ||
      (!batch && collecting)
    ) {
      sourceEl?.copy?.remove();
      return false;
    }
    // 必须先捕获松手位置，再改列表；否则渲染会把源照片归位。
    const captured = continuous ? null : sourceEl?.copy ? sourceEl : effects.capture(sourceEl),
      sourceBounds = continuous ? effects.rect(sourceEl) : captured?.bounds,
      index = nextPinSlot++,
      order = state.items.indexOf(item);
    const width = 200,
      height = Math.min(180, Math.round(width / item.aspect));
    const pin = {
      item,
      width,
      height,
      x: clamp(dragged ? sourceBounds.x : 80 + (index % 3) * 224, 16, state.width - width - 16),
      y: clamp(dragged ? sourceBounds.y : 320 + (Math.floor(index / 3) % 3) * 140, 32, state.height - 40 - height),
      pending: true,
    };
    taking.add(id);
    if (handoff) handoffs.set(id, handoff);
    if (continuous) { $("takeProgress").hidden = false; sendRegions(); }
    renderCards();
    try {
      const create = continuous ? bridge.dragTake : bridge.take;
      pin.native = await create(item, { x: pin.x, y: pin.y, width: pin.width, height: pin.height });
      if (disposed) {
        await bridge.restore([item]);
        await bridge.closePin(pin.native);
        captured?.copy.remove();
        return false;
      }
      if (continuous) {
        const landing = effects.rect(sourceEl);
        const transfer = handoff?.release() || { held: false, cancelled: false };
        if (transfer.cancelled || disposed) {
          await bridge.restore([item]);
          if (!disposed) await bridge.order(state.items.map((photo) => photo.id));
          await bridge.closePin(pin.native);
          return false;
        }
        const size = bridge.logical(pin.native.rect);
        pin.key = pin.native.hwnd + ':' + pin.native.generation;
        awaitingDragAcks.add(pin.key);
        pin.native = await bridge.startDrag(pin.native, { x: landing.x, y: landing.y, width: size.width, height: size.height }, transfer.held, transfer.point);
      }
      pin.key = pin.native.hwnd + ":" + pin.native.generation;
      const rect = bridge.logical(pin.native.rect);
      Object.assign(pin, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    } catch (error) {
      earlyNativeDrops.delete(pin.key);
      handoff?.release();
      if (pin.native) {
        try {
          await bridge.restore([item]);
          if (!disposed) await bridge.order(state.items.map((photo) => photo.id));
          await bridge.closePin(pin.native);
        } catch (recoveryError) {
          bridge.safe(bridge.showPin(pin.native));
          toast('取下未完成，贴图已保留 · ' + String(recoveryError));
          captured?.copy.remove();
          return false;
        }
      }
      captured?.copy.remove();
      toast("贴图创建失败，原图留在绳上 · " + String(error));
      return false;
    } finally {
      awaitingDragAcks.delete(pin.key);
      taking.delete(id);
      handoffs.delete(id);
      cancelledTakes.delete(id);
      if (!disposed) {
        if (!handoffs.size) $("takeProgress").hidden = true;
        renderCards();
        draw(curve);
      }
    }
    if (disposed) { captured?.copy.remove(); return false; }
    state.pins.push(pin);
    if (continuous) pin.pending = false; // 原生拖放拥有显隐，绳层隐藏不能提前亮出大贴图挡住目标。
    state.items = state.items.filter((i) => i.id !== id);
    renderPins();
    update(-90);
    if (continuous) {
      captured?.copy.remove();
      // Native Esc / release may arrive before startDrag's IPC acknowledgement registers the pin.
      const pendingDrop = earlyNativeDrops.get(pin.key);
      earlyNativeDrops.delete(pin.key);
      if (pendingDrop) bridge.safe(nativeDrop(pendingDrop));
      return true;
    }
    const completed = await effects.transfer(
      id,
      captured,
      $("pins").querySelector(`[data-pin="${pin.key}"]`),
      "pin",
      dragged,
    );
    if (completed && state.pins.includes(pin)) {
      try {
        await bridge.showPin(pin.native);
      } catch (error) {
        pin.pending = false;
        state.pins = state.pins.filter(p => p !== pin);
        if (!state.items.some(p => p.id === id)) state.items.splice(Math.min(order, state.items.length), 0, item);
        renderPins();
        update(0, true);
        try { await bridge.restore([item]); await bridge.order(state.items.map(p => p.id)); }
        catch (restoreError) { toast("贴图显示失败，恢复未确认 · " + String(restoreError)); return false; }
        bridge.safe(bridge.closePin(pin.native));
        toast("贴图显示失败，照片已留在绳上 · " + String(error));
        return false;
      }
      pin.pending = false;
      renderPins();
      renderCards();
    }
    return completed || (!pin.pending && state.pins.includes(pin));
  }
  async function hangBack(
    pin,
    slot = geometry.cards.length,
    sourceEl = $("pins").querySelector(`[data-pin="${pin.key}"]`),
    dragged = false,
    operation,
  ) {
    // 只挡「这一张」自己的在途状态；别的照片在取挂不该拦住它。
    if (!pin || pin.pending || pin.pendingBack) return;
    const id = pin.item.id;
    if (taking.has(id) || state.pins.some((p) => p !== pin && p.item.id === id && (p.pending || p.pendingBack))) return;
    if (!state.enabled || clearOperation) {
      renderPins();
      toast("请先开启晾衣绳，或等待本阵大风结束");
      return;
    }
    const captured = effects.capture(sourceEl);
    pin.pendingBack = true;
    renderPins();
    renderCards();
    if (captured) captured.copy.style.visibility = 'hidden';
    try {
      if (!pin.item.url || pin.item.error) Object.assign(pin.item, await bridge.prepare(pin.item, true));
      let ready = photo(pin.item);
      try {
        const image = ready.querySelector('img');
        if (image?.decode) await image.decode();
      } catch {
        Object.assign(pin.item, await bridge.prepare(pin.item, true));
        ready = photo(pin.item);
        const image = ready.querySelector('img');
        if (image?.decode) await image.decode();
      }
      delete pin.item.error;
      captured?.copy.querySelector('.photo')?.replaceWith(ready);
      if (disposed || operation?.cancelled) {
        pin.pendingBack = false;
        captured?.copy.remove();
        if (!disposed) { renderPins(); renderCards(); }
        return;
      }
      if (operation) operation.committing = true;
      await bridge.returnPin(pin.native, id, slot);
    } catch (error) {
      pin.pendingBack = false;
      captured?.copy.remove();
      if (disposed) return;
      renderPins();
      renderCards();
      toast("挂回失败，原贴图保留 · " + String(error));
      return;
    }
    if (disposed) { captured?.copy.remove(); return; }
    if (captured) captured.copy.style.visibility = 'visible';
    state.pendingHangs.add(id);
    state.items = insertAtSlot(
      state.items,
      pin.item,
      slot,
      Math.min(8, Math.max(1, Math.floor((geometry.span + 12) / 126))),
    );
    renderPins();
    update(100);
    bridge.safe(bridge.order(state.items.map((i) => i.id)));
    const completed = await effects.transfer(id, captured, cards.get(id), "hang", dragged);
    if (completed && state.pendingHangs.has(id)) {
      state.pendingHangs.delete(id);
      state.pins = state.pins.filter((p) => p !== pin);
      renderPins();
      renderCards();
      draw(curve);
    }
    flushSnapshot();
  }

  async function gather() {
    if (state.nativeReceiving || collecting || clearOperation) return;
    gestures.cancelDrag();
    closePreview(false);
    collecting = true;
    batchStopped = false;
    const snapshot = geometry.cards.map(card => card.item),
      sources = new Map(snapshot.map((item) => [item.id, effects.capture(cards.get(item.id))]));
    renderCards();
    const results = new Array(snapshot.length).fill(false);
    let next = 0;
    let done = 0;
    const progress = () => {
      $("batchProgress").hidden = false;
      $("batchProgress").textContent = `${batchStopped ? '停止中' : '正在收衣'} ${done}/${snapshot.length} · 排队保留`;
      $("stopBatch").hidden = false;
      $("stopBatch").disabled = batchStopped;
      toolbarSize = null;
      draw(curve);
    };
    progress();
    // 解码原图与建窗有瞬时内存峰值；排队很多时也只允许两份在途。
    const worker = async () => {
      while (next < snapshot.length && !batchStopped && !disposed) {
        const index = next++,
          item = snapshot[index];
        try {
          results[index] = await takeItem(item.id, sources.get(item.id), false, true);
        } catch (error) {
          sources.get(item.id)?.copy.remove();
          toast("收衣未完成 · " + String(error));
        } finally {
          done++;
          progress();
        }
      }
    };
    await Promise.all([worker(), worker()]);
    sources.forEach(captured => captured?.copy.remove());
    $("batchProgress").hidden = true;
    $("stopBatch").hidden = true;
    collecting = false;
    const succeeded = snapshot.filter((_, i) => results[i]);
    renderCards();
    if (!succeeded.length) {
      toast(batchStopped ? "已停止收衣，剩余照片留在绳上" : "收衣失败，原图仍在绳上 · 请重试");
      return;
    }
    if (succeeded.length < snapshot.length)
      toast("已转贴图 " + succeeded.length + "/" + snapshot.length + " 张；失败照片仍在绳上，可重试");
  }
  async function clearRope() {
    if (state.nativeReceiving || !state.items.length || clearOperation || collecting) return;
    gestures.cancelDrag();
    closePreview(false);
    const snapshot = [...state.items];
    const operation = { ids: new Set(snapshot.map((i) => i.id)) };
    clearOperation = operation;
    renderCards();
    try {
      await bridge.remove(snapshot.map((i) => i.id));
    } catch (error) {
      clearOperation = null;
      renderCards();
      toast("清空未完成，照片仍保留 · " + String(error));
      return;
    }
    state.clearingIds = new Set(operation.ids);
    // 先冻结所有可见源，再逐张卸重；排队图不会把离场时长拉长。
    const captured = new Map(
      geometry.cards.map((card) => [card.item.id, reduced() ? null : effects.capture(cards.get(card.item.id))]),
    );
    // Queued photos have no departure animation; remove them together instead of rendering per photo.
    state.items = state.items.filter(item => !operation.ids.has(item.id) || captured.has(item.id));
    update(0);
    let visibleIndex = 0;
    const operations = snapshot.filter(item => captured.has(item.id)).map((item) =>
      effects.gale(item.id, captured.get(item.id), captured.has(item.id) ? visibleIndex++ : 0, () => {
        if (clearOperation !== operation) return;
        state.items = state.items.filter((i) => i.id !== item.id);
        update(-35);
      }),
    );
    renderCards();
    scheduleWind();
    await Promise.all(operations);
    if (clearOperation !== operation) return;
    clearOperation = null;
    state.clearingIds.clear();
    renderCards();
    renderPins();
    scheduleWind();
    toast("已吹走 " + snapshot.length + " 张 · 剪贴板历史保留");
  }
  function reorder(id, slot) {
    const item = state.items.find((i) => i.id === id);
    if (!item) return;
    const positions = new Map([...cards].map(([key, el]) => [key, parseFloat(el.style.left)]));
    state.items = insertAtSlot(state.items, item, slot, geometry.cards.length);
    bridge.safe(bridge.order(state.items.map((i) => i.id)));
    update(45);
    if (!reduced())
      for (const [key, el] of cards) {
        const dx = (positions.get(key) ?? parseFloat(el.style.left)) - parseFloat(el.style.left);
        if (dx)
          el.animate([{ translate: dx + "px 0" }, { translate: "0px 0" }], {
            duration: 200,
            easing: "cubic-bezier(.05,.7,.1,1)",
          });
      }
  }
  function commitAnchors() {
    state.custom = true;
    saveAnchors();
    update(30);
  }
  function previewSlot(id, slot, itemOverride) {
    for (const el of cards.values()) {
      el.style.translate = "";
      el.style.opacity = "";
    }
    if (id === null) return;
    const item = itemOverride || state.items.find((i) => i.id === id) || state.pins.find((p) => p.item.id === id)?.item;
    if (!item) return;
    const capacity = Math.min(8, Math.max(1, Math.floor((geometry.span + 12) / 126)));
    const preview = layout(state.width, insertAtSlot(state.items, item, slot, capacity), state.anchors);
    for (const card of geometry.cards) {
      if (card.item.id === id) continue;
      const next = preview.cards.find((c) => c.item.id === card.item.id),
        el = cards.get(card.item.id);
      if (next) el.style.translate = next.x - card.x + "px 0";
      else el.style.opacity = ".35";
    }
    return preview.cards.find((c) => c.item.id === id);
  }
  function openPreview(id) {
    const item = state.items.find((x) => x.id === id);
    if (!item) return;
    returnFocus = document.activeElement;
    previewId = id;
    regionCache.delete('loupe');
    const request = ++previewRequest;
    $("loupeImage").classList.remove('previewActual');
    $("loupeImage").style.setProperty('--original-width', (item.width / (state.scale || 1)) + 'px');
    $("loupeImage").style.setProperty('--original-height', (item.height / (state.scale || 1)) + 'px');
    $("fitImage").setAttribute('aria-pressed', 'true');
    $("actualImage").setAttribute('aria-pressed', 'false');
    $("actualImage").disabled = true;
    $("previewLoad").hidden = false;
    $("previewLoad").textContent = '原图读取中…';
    $("loupeImage").replaceChildren(photo(item));
    $("loupeCaption").textContent = item.name;
    $("loupe").hidden = false;
    previewAnimation?.cancel();
    if (!reduced() && visible && !document.hidden) {
      const source = cards.get(id)?.getBoundingClientRect(),
        targetBox = $("loupe").getBoundingClientRect();
      const dx = source ? source.left + source.width / 2 - targetBox.left - targetBox.width / 2 : 0,
        dy = source ? source.top + source.height / 2 - targetBox.top - targetBox.height / 2 : 8,
        scale = source
          ? clamp(
              Math.min(source.width / Math.max(1, targetBox.width), source.height / Math.max(1, targetBox.height)),
              0.04,
              1,
            )
          : 0.96;
      const animation = $("loupe").animate(
        [
          { translate: `${dx}px ${dy}px`, scale, opacity: 0 },
          { translate: "0px 0px", scale: 1, opacity: 1 },
        ],
        { duration: 300, easing: "cubic-bezier(.05,.7,.1,1)" },
      );
      previewAnimation = animation;
      animation.finished
        .catch(() => {})
        .finally(() => {
          if (previewAnimation === animation) {
            previewAnimation = null;
            // 原生命中区域需要最终矩形，不能停在展开动画的第一帧。
            if (!disposed && previewId === id) { regionCache.delete('loupe'); sendRegions(); }
          }
        });
    }
    bridge.safe(bridge.focusPreview());
    sendRegions();
    interactionChanged();
    $("closePreview").focus();
    bridge.safe(
      originals.load(item, () => previewId === id && !disposed).then((url) => {
        if (previewRequest !== request || disposed) return;
        $("loupeImage").replaceChildren(photo({ ...item, url }));
        $("actualImage").disabled = false;
        $("previewLoad").hidden = true;
        regionCache.delete('loupe');
        sendRegions();
      }).catch(error => {
        if (previewRequest !== request || disposed) return;
        $("previewLoad").textContent = '原图读取失败，缩略图保留 · ' + String(error);
        const retry = document.createElement('button'); retry.textContent = '重试原图';
        retry.onclick = () => { originals.invalidate(item); openPreview(id); };
        $("previewLoad").append(retry);
        regionCache.delete('loupe');
        sendRegions();
      }),
    );
  }
  function closePreview(focus = true) {
    if (previewId === null) return;
    previewId = null;
    previewRequest++;
    regionCache.delete('loupe');
    previewAnimation?.cancel();
    previewAnimation = null;
    $("loupe").hidden = true;
    $("loupeImage").replaceChildren();
    sendRegions();
    if (focus && returnFocus?.isConnected) returnFocus.focus();
    focused = false;
    interactionChanged();
  }
  $("pinPreview").onclick = () => {
    const id = previewId;
    closePreview(false);
    takeItem(id);
  };
  $("closePreview").onclick = () => closePreview();
  for (const [id, actual] of [['fitImage', false], ['actualImage', true]]) $(id).onclick = () => {
    $("loupeImage").classList.toggle('previewActual', actual);
    $("fitImage").setAttribute('aria-pressed', String(!actual));
    $("actualImage").setAttribute('aria-pressed', String(actual));
    $("loupeImage").scrollTop = 0; $("loupeImage").scrollLeft = 0;
    regionCache.delete('loupe');
    sendRegions();
  };
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (previewId !== null && !$("loupe").contains(event.target)) closePreview(false);
    },
    { capture: true, signal: lifecycle.signal },
  );
  gestures = installGestures({
    stage: $("stage"),
    hangs: $("hangs"),
    left: $("anchorLeft"),
    right: $("anchorRight"),
    mover: $("moveRope"),
    marker: $("slotMarker"),
    hint: $("dragHint"),
    getState: () => state,
    getGeometry: () => geometry,
    getCurve: () => curve,
    onAnchors: (anchors) => {
      const dx = (anchors.left.x + anchors.right.x - state.anchors.left.x - state.anchors.right.x) / 2,
        dy = (anchors.left.y + anchors.right.y - state.anchors.left.y - state.anchors.right.y) / 2;
      state.anchors = anchors;
      geometry = layout(state.width, state.items, state.anchors);
      target = equilibrium(geometry);
      renderCards();
      bridge.safe(prepareItems(state.items));
      // 端点直接跟手，绳身保留少量惯性；复用统一弹簧，隐藏/减少动态仍停止。
      const bend = reduced() ? 0 : clamp(-dy - dx * 0.12, -18, 18);
      draw(target.map((y, i) => y + bend * Math.sin((Math.PI * i) / 64)));
      settle(0, true);
    },
    onAnchorCommit: (before, custom) => commitAnchors(before, custom),
    onDetach: (id, el, dragged, continuous, handoff) => takeItem(id, el, dragged, false, continuous, handoff),
    onTransferEnd: (cancelled, id) => {
      if (disposed) return;
      if (cancelled) { cancelledTakes.add(id); draw(target); }
    },
    onReorder: reorder,
    onPreview: openPreview,
    onError: (error) => toast('拖动未开始，请重试 · ' + String(error)),
    onInteraction: (active) => {
      if (disposed) return;
      dragging = active;
      interactionChanged();
      // 原生穿透判断也要知道捕获的起止，不能等下一次绳形重绘才更新。
      sendRegions();
    },
    onFinish: () => {
      if (disposed) return;
      draw(target);
      settle();
    },
    onGeometryCancel: (anchors) => {
      if (disposed) return;
      state.anchors = anchors;
      update(0, true);
    },
    onSlotPreview: previewSlot,
  });
  for (const [id, side] of [
    ["anchorLeft", "left"],
    ["anchorRight", "right"],
    ["moveRope", "whole"],
  ])
    $(id).onkeydown = (e) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key) || $(id).disabled)
        return;
      e.preventDefault();
      const step = e.shiftKey ? 16 : 4,
        dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0,
        dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      const before = structuredClone(state.anchors);
      if (side === "whole") state.anchors = moveAnchors(before, dx, dy, state.width, state.height);
      else {
        const next = structuredClone(before);
        next[side].x += dx;
        next[side].y += dy;
        state.anchors = constrainAnchors(next, side, state.width, state.height);
      }
      commitAnchors();
    };
  $("hangs").onkeydown = (e) => {
    if (e.target.closest("button")) return;
    const el = e.target.closest(".hang");
    if (el && ["Enter", " "].includes(e.key)) {
      e.preventDefault();
      openPreview(el.dataset.id);
    }
  };
  document.onkeydown = (e) => {
    if (e.key === "Escape") {
      if (collecting) { batchStopped = true; $("stopBatch").disabled = true; }
      else if (state.nativeReceiving) {
        let cancelled = false;
        for (const operation of nativeReceivers.values()) if (!operation.committing) { operation.cancelled = true; cancelled = true; }
        toast(cancelled ? '正在结束挂回准备，原贴图保留' : '正在完成挂回');
      }
      else if (handoffs.size) { for (const handoff of handoffs.values()) handoff.cancel?.(); }
      else if (gestures.isDragging()) gestures.cancelDrag();
      else closePreview();
    }
  };
  $("stopBatch").onclick = () => { batchStopped = true; $("stopBatch").disabled = true; };
  $("cancelTake").onclick = () => { for (const handoff of handoffs.values()) handoff.cancel?.(); };
  $("stage").onpointermove = (e) => {
    const next = !!e.target.closest(".hang,.loupe,.pinPanel,.pinGhost,.anchor,.moveGrip");
    if (next !== hovered) {
      hovered = next;
      interactionChanged();
    }
  };
  $("stage").onpointerleave = () => {
    hovered = false;
    interactionChanged();
  };
  $("stage").onfocusin = () => {
    focused = true;
    interactionChanged();
  };
  $("stage").onfocusout = (e) => {
    if (!$("stage").contains(e.relatedTarget)) {
      focused = false;
      interactionChanged();
    }
  };
  $("clear").onclick = () => bridge.safe(clearRope());
  $("gather").onclick = () => bridge.safe(gather());
  $("locked").onchange = () => {
    gestures.cancelDrag();
    state.locked = $("locked").checked;
    bridge.safe(bridge.config({ clothesline_locked: state.locked }));
    renderCards();
  };
  $("restoreAnchors").onclick = () => {
    if ($("restoreAnchors").disabled) return;
    state.anchors = defaultAnchors(state.width);
    state.custom = false;
    saveAnchors();
    update(30);
  };
  systemReduce.onchange = () => update(0, true);
  document.onvisibilitychange = () => {
    if (document.hidden) {
      gestures.cancelDrag();
      stop();
      clearTimeout(windTimer);
      windTimer = 0;
      finishHiddenEffects();
    } else {
      update(0, true);
    }
  };
  window.addEventListener(
    "blur",
    () => {
      // Native window preparation can change focus while the pointer is still captured.
      // Actual hiding, pointer cancellation and Esc own cancellation; blur only pauses motion.
      stop();
      clearTimeout(windTimer);
      windTimer = 0;
    },
    { signal: lifecycle.signal },
  );
  window.addEventListener("focus", () => update(0, true), { signal: lifecycle.signal });
  window.addEventListener(
    "resize",
    () => {
      if (state.pendingHangs.size) { effects.cancelAll(); state.pendingHangs.clear(); state.pins = state.pins.filter(p => !p.pendingBack); flushSnapshot(); }
      const oldWidth = state.width,
        oldHeight = state.height;
      resize();
      if (state.custom) {
        for (const side of ["left", "right"]) {
          state.anchors[side].x *= state.width / oldWidth;
          state.anchors[side].y *= state.height / oldHeight;
        }
        state.anchors = constrainAnchors(
          constrainAnchors(state.anchors, "right", state.width, state.height),
          "left",
          state.width,
          state.height,
        );
      } else state.anchors = defaultAnchors(state.width);
      update(0, true);
    },
    { signal: lifecycle.signal },
  );

  async function receive(snapshot, initial = false) {
    if (disposed) return;
    if (state.pendingHangs.size && !initial) { waitingSnapshot = snapshot; return; }
    const configurationChanged =
      JSON.stringify(snapshot.anchors) !== JSON.stringify(lastAnchors) || snapshot.locked !== state.locked;
    state.enabled = snapshot.enabled;
    state.scale = snapshot.scale;
    state.wind = snapshot.wind;
    state.locked = snapshot.locked;
    $("enabled").checked = state.enabled;
    $("wind").checked = state.wind;
    $("locked").checked = state.locked;
    if (configurationChanged || initial) {
      applyAnchors(snapshot.anchors);
      lastAnchors = structuredClone(snapshot.anchors);
    }
    const presentIds = new Set(state.items.map(item => item.id));
    const added = snapshot.items.filter(
      (item) => !presentIds.has(item.id) && !taking.has(item.id) && !state.clearingIds.has(item.id),
    );
    for (const item of added) state.items.push({ ...item, aspect: item.width / Math.max(1, item.height), weight: 1 });
    // 重新采集排队旧图时，后端会把它移到最新位置；进行中的转场保留自己的快照。
    if (
      !clearOperation &&
      !taking.size &&
      !state.pendingHangs.size &&
      !collecting &&
      !state.pins.some((p) => p.pendingBack)
    ) {
      const current = new Map(state.items.map((item) => [item.id, item]));
      state.items = snapshot.items.map((item) => current.get(item.id)).filter(Boolean);
    }
    resize();
    update(initial ? 0 : added.length ? 130 : 0, initial || configurationChanged);
  }
  function flushSnapshot() {
    if (!waitingSnapshot || state.pendingHangs.size) return;
    const next = waitingSnapshot; waitingSnapshot = null;
    bridge.safe(receive(next));
  }
  function nativeSlot(pin) {
    const rect = bridge.logical(pin.rect),
      point = nativeContact(pin, rect),
      same = nativeRope?.hwnd === pin.hwnd && nativeRope?.generation === pin.generation,
      g = same ? nativeRope.geometry : geometry,
      values = same ? nativeRope.curve : curve,
      active = nativeDragging?.hwnd === pin.hwnd && nativeDragging?.generation === pin.generation,
      contact = ropeDrop(g, values, point.x);
    if (point.x < g.left - (active ? 48 : 24) || point.x > g.right + (active ? 48 : 24) || Math.abs(point.y - contact.y) > (active ? 96 : 64))
      return null;
    const index = geometry.cards.findIndex((card) => point.x < card.x);
    return index < 0 ? geometry.cards.length : index;
  }
  function nativeContact(pin, rect = bridge.logical(pin.rect)) {
    const left = Math.max(0, rect.x), right = Math.min(state.width, rect.x + rect.width);
    const pointer = pin.point && bridge.logical({ x: pin.point[0], y: pin.point[1], width: 1, height: 1 });
    const x = pointer ? pointer.x : right >= left ? (left + right) / 2 : rect.x + rect.width / 2;
    // Native drag previews follow the pointer; an original-sized top edge must not cause accidental hanging.
    return {x, y:pointer ? pointer.y : rect.y};
  }
  function nativePreview(pin) {
    if (state.nativeReceiving || disposed) return;
    if (nativeRope?.hwnd !== pin.hwnd || nativeRope?.generation !== pin.generation)
      nativeRope = { hwnd: pin.hwnd, generation: pin.generation, geometry: structuredClone(geometry), curve: [...curve] };
    const slot = nativeSlot(pin);
    if (slot === null) {
      cancelNativePreview(true);
      return;
    }
    dragging = true;
    nativeDragging = pin;
    clearTimeout(idleTimer);
    interactionChanged();
    const rect = bridge.logical(pin.rect),
      p = ropeDrop(geometry, curve, nativeContact(pin, rect).x);
    const known = state.pins.find((p) => p.native?.hwnd === pin.hwnd && p.native?.generation === pin.generation)?.item;
    previewSlot(
      known?.id || "native-preview",
      slot,
      known || { id: "native-preview", aspect: rect.width / rect.height },
    );
    const marker = $("slotMarker");
    marker.style.left = clamp(p.x - 50, geometry.left, geometry.right - 100) + "px";
    marker.style.top = p.y + 6 + "px";
    marker.style.width = "100px";
    marker.style.height = "70px";
    marker.hidden = false;
    $("dragHint").textContent = "松手挂回 · Esc 取消";
    $("dragHint").hidden = false;
    sendRegions();
  }
  async function nativeDrop(pin) {
    if (disposed) return;
    const key = pin.hwnd + ':' + pin.generation;
    if (awaitingDragAcks.has(key)) {
      earlyNativeDrops.set(key, pin);
      return;
    }
    // 同一张贴图的重复 drop 只处理一次；别的照片在途不再拦这一张。
    // 旧版用 taking.size / nativeReceiving 做全局拦截，第二张会被弹回并回一句
    // 「请稍候」，用户看到的就是「挂了没反应」。
    if (nativeReceivers.has(key)) return;
    const slot = pin.force ? geometry.cards.length : nativeSlot(pin);
    nativeRope = null;
    dragging = false;
    nativeDragging = null;
    previewSlot(null, null);
    $("slotMarker").hidden = true;
    $("dragHint").hidden = true;
    interactionChanged();
    if (slot === null) {
      // Explicit rejection completes the native handoff; otherwise its hidden source would wait for a watchdog.
      bridge.safe(bridge.showPin(pin));
      queueIdle();
      return;
    }
    const operation = {cancelled:false, committing:false};
    nativeReceivers.set(key, operation);
    clearTimeout(idleTimer);
    renderCards();
    interactionChanged();
    try {
      const existing = state.pins.find((p) => p.native?.hwnd === pin.hwnd && p.native?.generation === pin.generation);
      const item = existing?.item || (await bridge.photoForPin(pin));
      if (disposed) return;
      if (operation.cancelled) { toast('挂回已停止'); return; }
      const rect = bridge.logical(pin.rect), current = {
        item, native:pin, key, x:rect.x, y:rect.y, width:rect.width, height:rect.height,
      };
      if (existing) Object.assign(existing, current);
      else state.pins.push(current);
      renderPins();
      await hangBack(existing || current, slot, undefined, false, operation);
    } finally {
      nativeReceivers.delete(key);
      if (!disposed) {
        renderCards(); interactionChanged(); queueIdle();
        if (!toastTimer && !$("toast").hidden) scheduleToastHide();
      }
    }
  }
  function cancelNativePreview(keepRope = false) {
    if (!keepRope) nativeRope = null;
    dragging = false;
    nativeDragging = null;
    previewSlot(null, null);
    $("slotMarker").hidden = true;
    $("dragHint").hidden = true;
    interactionChanged();
    sendRegions();
    queueIdle();
  }
  function finishHiddenEffects() {
    effects.cancelAll();
    if (clearOperation) {
      state.items = state.items.filter((i) => !clearOperation.ids.has(i.id));
      clearOperation = null;
      state.clearingIds.clear();
    }
    for (const pin of state.pins)
      if (pin.pending) {
        pin.pending = false;
        bridge.safe(bridge.showPin(pin.native));
      }
    state.pins = state.pins.filter((pin) => !state.pendingHangs.has(pin.item.id));
    state.pendingHangs.clear();
    flushSnapshot();
    document.getAnimations?.().forEach((animation) => animation.finish());
    clearTimeout(toastTimer);
    $("toast").hidden = true;
  }
  let lastAnchors;
  window.addEventListener("pagehide", dispose, { signal: lifecycle.signal });
  try {
  const initial = await bridge.snapshot();
  await bridge.subscribe({
    update: (snapshot) => receive(snapshot),
    visible: (value) => {
      visible = value;
      if (!value) {
        closePreview(false);
        gestures.cancelDrag();
        stop();
        clearTimeout(windTimer);
        windTimer = 0;
        cancelAnimationFrame(regionsFrame);
        regionsFrame = 0;
        finishHiddenEffects();
      } else {
        update(0, true);
        sendRegions();
      }
    },
    hover: (value) => {
      hovered = value;
      interactionChanged();
    },
    pinPreview: (pin) => (pin ? nativePreview(pin) : cancelNativePreview()),
    pinDrop: nativeDrop,
    pinClosed: (pin) => {
      const operation = nativeReceivers.get(pin.hwnd + ':' + pin.generation);
      if (operation) {
        operation.cancelled = true;
        if (!operation.committing) toast('贴图已关闭，挂回已停止');
      }
      if (nativeDragging?.hwnd === pin.hwnd && nativeDragging?.generation === pin.generation) cancelNativePreview();
      state.pins = state.pins.filter((p) => p.native?.hwnd !== pin.hwnd || p.native?.generation !== pin.generation);
      renderPins();
      renderCards();
    },
    dismissPreview: () => closePreview(false),
  });
  if (disposed) { bridge.dispose(); return () => {}; }
  document.addEventListener("clothesline-error", (event) => toast("操作未完成 · " + event.detail + " · 可重试"), {
    signal: lifecycle.signal,
  });
  $("managePins").onclick = bridge.manager;
  resize();
  await receive(initial, true);
  initialized = true;
  renderPins();
  // ready 会让原生窗口显示；隐藏 WebView 的动画帧可能暂停，握手不能依赖它。
  await bridge.ready();
  } catch (error) { dispose(); throw error; }
  sendRegions();
  function dispose() {
    if (disposed) return;
    disposed = true;
    gestures?.cancelDrag();
    lifecycle.abort();
    previewAnimation?.cancel();
    stop();
    effects.cancelAll();
    bridge.dispose();
    originals.clear();
    earlyNativeDrops.clear();
    awaitingDragAcks.clear();
    [idleTimer, windTimer, toastTimer].forEach(clearTimeout);
    cancelAnimationFrame(regionsFrame);
    document.onkeydown = null;
    document.onvisibilitychange = null;
    systemReduce.onchange = null;
  }
  return dispose;
}
