import { WIND_TIMING } from "./physics.mjs";

export function createEffects({ stage, layer, reduced }) {
  const running = new Map();
  function rect(el) {
    const a = el.getBoundingClientRect(),
      b = stage.getBoundingClientRect();
    const zoom = parseFloat(stage.style.getPropertyValue("--zoom")) || 1;
    return { x: (a.left - b.left) / zoom, y: (a.top - b.top) / zoom, w: a.width / zoom, h: a.height / zoom };
  }
  function capture(el) {
    if (!el) return null;
    const bounds = rect(el),
      copy = el.cloneNode(true);
    const image = el.querySelector('img');
    const aspect = image?.naturalWidth && image?.naturalHeight ? image.naturalWidth / image.naturalHeight : bounds.w / Math.max(1,bounds.h);
    const imageBounds = fittedRect(el.querySelector('.photo') || el, aspect, bounds);
    copy.removeAttribute("id");
    copy.removeAttribute("tabindex");
    copy.removeAttribute("role");
    copy
      .querySelectorAll("button,[id]")
      .forEach((node) => (node.tagName === "BUTTON" ? node.remove() : node.removeAttribute("id")));
    copy.classList.remove("dragging");
    copy.classList.add("effectCopy");
    Object.assign(copy.style, {
      position: "absolute",
      left: bounds.x + "px",
      top: bounds.y + "px",
      width: bounds.w + "px",
      height: bounds.h + "px",
      transform: "none",
      visibility: "visible",
      transformOrigin: "0 0",
    });
    layer.append(copy);
    return { copy, bounds, imageBounds, aspect };
  }
  function fittedRect(el, aspect, fallback) {
    let box = rect(el);
    if (!box.w || !box.h) box = fallback;
    const w = Math.min(box.w, box.h * (aspect || box.w / Math.max(1,box.h))), h = w / (aspect || 1);
    return { x: box.x + (box.w-w)/2, y: box.y + (box.h-h)/2, w, h };
  }
  function cancel(id) {
    const operation = running.get(id);
    if (operation) operation.cancel();
  }
  function cancelAll() {
    [...running.keys()].forEach(cancel);
  }

  async function transfer(id, captured, destination, mode, dragged = false) {
    cancel(id);
    if (!captured || !destination || reduced()) {
      captured?.copy.remove();
      return true;
    }
    const { copy, bounds } = captured,
      end = rect(destination),
      delay = dragged ? 0 : 200;
    const animations = [];
    const run = (node, keys, options) => {
      const a = node.animate(keys, options);
      animations.push(a);
      return a;
    };
    const picture = copy.querySelector('.photo');
    const startImage = captured.imageBounds || bounds;
    const imageEnd = fittedRect(destination.querySelector('.photo') || destination, captured.aspect, end);
    const options = { duration: 400, delay, easing: 'cubic-bezier(.05,.7,.1,1)', fill: 'both' };
    if (picture) {
      const sourceFrame = copy.querySelector('.frame');
      if (sourceFrame) sourceFrame.style.height = Math.max(1, bounds.h - 5) + 'px';
      // Image and paper move separately: only the empty paper can change its aspect ratio.
      picture.classList.add('transferPicture');
      Object.assign(picture.style, { position:'absolute', left:startImage.x+'px', top:startImage.y+'px', width:startImage.w+'px', height:startImage.h+'px', transformOrigin:'0 0', overflow:'hidden' });
      layer.append(picture);
    }
    if (mode === 'hang') {
      const paper = destination.querySelector('.frame')?.cloneNode(true);
      copy.replaceChildren();
      if (paper) { paper.querySelectorAll('.photo,button').forEach(node=>node.remove()); paper.style.height=(end.h-5)+'px'; copy.append(paper); }
      copy.style.width=end.w+'px';copy.style.height=end.h+'px';
    }
    const decoration = mode === 'hang'
      ? [{transform:`translate(0,0) scale(${bounds.w / Math.max(1,end.w)},${bounds.h / Math.max(1,end.h)})`,opacity:0}, {transform:`translate(${end.x-bounds.x}px,${end.y-bounds.y}px) scale(1,1)`,opacity:1}]
      : [{transform:'translate(0,0) scale(1,1)',opacity:1}, {transform:`translate(${end.x-bounds.x}px,${end.y-bounds.y}px) scale(${end.w / Math.max(1,bounds.w)},${end.h / Math.max(1,bounds.h)})`,opacity:0}];
    const paperMotion = run(copy, decoration, options);
    const scale = imageEnd.w / Math.max(1,startImage.w);
    const motion = picture ? run(picture, [
      {transform:'translate(0,0) scale(1)'},
      {transform:`translate(${imageEnd.x-startImage.x}px,${imageEnd.y-startImage.y}px) scale(${scale})`},
    ], options) : paperMotion;
    let cancelled = false;
    const operation = {
      cancel: () => {
        cancelled = true;
        animations.forEach((a) => a.cancel());
        copy.remove();
        picture?.remove();
      },
    };
    running.set(id, operation);
    try {
      await motion.finished;
      return !cancelled;
    } catch {
      return false;
    } finally {
      copy.remove();
      picture?.remove();
      if (running.get(id) === operation) running.delete(id);
    }
  }

  function gale(id, el, index, onRelease) {
    cancel(id);
    if (reduced() || !el) {
      onRelease();
      return Promise.resolve(true);
    }
    const captured = el.copy ? el : capture(el),
      { copy, bounds } = captured;
    const lead = WIND_TIMING.lead + index * WIND_TIMING.stagger;
    const distance = parseFloat(stage.style.getPropertyValue("--sw")) - bounds.x + bounds.w;
    const a = copy.animate(
      [
        { transform: "translate(0,0) rotate(0deg)", opacity: 1 },
        { transform: "translate(12px,-4px) rotate(-5deg)", opacity: 1, offset: lead / (lead + 800) },
        {
          transform: `translate(${distance * 0.28}px,-22px) rotate(5deg)`,
          opacity: 1,
          offset: (lead + 400) / (lead + 800),
        },
        {
          transform: `translate(${distance * 0.65}px,-62px) rotate(12deg)`,
          opacity: 1,
          offset: (lead + 650) / (lead + 800),
        },
        { transform: `translate(${distance}px,-100px) rotate(18deg)`, opacity: 0 },
      ],
      { duration: lead + WIND_TIMING.flight, easing: "linear", fill: "both" },
    );
    const clipAnimations = [...copy.querySelectorAll(".clip")].map((clip) =>
      clip.animate(
        [
          { opacity: 1, scale: "1 1" },
          { opacity: 0, scale: "1 .3" },
        ],
        { duration: 150, delay: lead - 150, fill: "forwards" },
      ),
    );
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) onRelease();
    }, lead);
    const operation = {
      cancel: () => {
        cancelled = true;
        clearTimeout(timer);
        a.cancel();
        clipAnimations.forEach((x) => x.cancel());
        copy.remove();
      },
    };
    running.set(id, operation);
    return a.finished
      .then(
        () => !cancelled,
        () => false,
      )
      .finally(() => {
        clearTimeout(timer);
        copy.remove();
        if (running.get(id) === operation) running.delete(id);
      });
  }
  return { capture, transfer, gale, cancel, cancelAll, rect };
}
