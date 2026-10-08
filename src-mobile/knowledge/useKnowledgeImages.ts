import { useCallback, useEffect, useRef, type RefObject } from "react";
import { mobileKnowledgeImage } from "@/lib/api/mobileKnowledge";

/** Four requests, eight retained images and 24 million retained pixels; no external auto-load. */
export function useKnowledgeImages(root: RefObject<HTMLDivElement | null>, content: string, active: boolean) {
  const current = useRef({ active, epoch: 0 });
  current.current.active = active;
  const pending = useRef<HTMLButtonElement[]>([]);
  const running = useRef(0);
  const cached = useRef(new Map<Element, HTMLImageElement>());
  const pixels = useRef(new Map<Element, number>());
  const heights = useRef(new Map<Element, number>());
  const retainedPixels = useRef(0);
  const decodeCancel = useRef(new Set<() => void>());
  const pump = useRef<() => void>(() => undefined);
  const release = useCallback((box: Element, image: HTMLImageElement) => {
    // Keep measured layout space when releasing decoded pixels, so reading does not jump.
    (box as HTMLElement).style.minHeight = `${Math.max(box.getBoundingClientRect().height, heights.current.get(box) || 0)}px`;
    image.remove(); image.src = ""; cached.current.delete(box);
    retainedPixels.current -= pixels.current.get(box) || 0; pixels.current.delete(box);
    heights.current.delete(box);
    const button = box.querySelector<HTMLButtonElement>("button");
    if (button) button.textContent = "加载图片";
    const view = box.querySelector<HTMLButtonElement>("[data-view-image]");
    if (view) view.hidden = true;
  }, []);
  const run = useCallback(async (load: HTMLButtonElement) => {
    const epoch = current.current.epoch;
    const source = load.dataset.localImage || "";
    const box = load.closest(".kb-image")!;
    const result = box.querySelector(".kb-image-result")!;
    const live = () => current.current.active && !document.hidden && current.current.epoch === epoch && !!root.current?.contains(box);
    try {
      const url = await mobileKnowledgeImage(source);
      if (!/^data:image\/(?:png|jpeg|gif|webp|bmp|x-icon);base64,/i.test(url)) throw new Error();
      if (!live()) return;
      await new Promise<void>((resolve, reject) => {
        const image = document.createElement("img");
        image.alt = box.querySelector("strong")?.textContent || "图片"; image.referrerPolicy = "no-referrer";
        let finished = false;
        const finish = (ok: boolean) => {
          if (finished) return; finished = true; clearTimeout(timeout);
          decodeCancel.current.delete(cancel); image.onload = null; image.onerror = null;
          if (!live()) { image.src = ""; resolve(); return; }
          if (!ok) { image.src = ""; reject(new Error()); return; }
          const size = image.naturalWidth * image.naturalHeight;
          if (size > 24_000_000) { image.src = ""; reject(new Error()); return; }
          const previous = cached.current.get(box); if (previous) release(box, previous);
          while (cached.current.size >= 8 || retainedPixels.current + size > 24_000_000) {
            const oldest = cached.current.entries().next().value;
            if (oldest) release(oldest[0], oldest[1]); else break;
          }
          box.append(image); cached.current.set(box, image); pixels.current.set(box, size); retainedPixels.current += size;
          heights.current.set(box, box.getBoundingClientRect().height);
          load.textContent = "重新加载"; result.textContent = ""; resolve();
          const fetch = box.querySelector<HTMLButtonElement>("[data-fetch-image]");
          if (fetch) fetch.hidden = true;
          const view = box.querySelector<HTMLButtonElement>("[data-view-image]");
          if (view) view.hidden = false;
        };
        const cancel = () => finish(false);
        const timeout = setTimeout(cancel, 15000);
        decodeCancel.current.add(cancel); image.onload = () => finish(true); image.onerror = cancel; image.src = url;
      });
    } catch {
      if (live()) {
        load.textContent = "重试图片";
        result.textContent = cached.current.has(box) ? "重新读取未能完成，当前图片仍可查看。" : "图片尚未在手机上可用。正文仍可阅读。";
        const fetch = box.querySelector<HTMLButtonElement>("[data-fetch-image]");
        if (fetch) fetch.hidden = false;
      }
    } finally {
      if (current.current.epoch === epoch && root.current?.contains(box)) load.disabled = false;
      running.current--; pump.current();
    }
  }, [release, root]);
  pump.current = () => {
    if (!current.current.active || document.hidden) return;
    while (running.current < 4 && pending.current.length) {
      const next = pending.current.shift()!;
      if (!root.current?.contains(next)) { next.disabled = false; continue; }
      running.current++; void run(next);
    }
  };
  const loadImage = useCallback((load: HTMLButtonElement) => {
    if (load.disabled || !current.current.active || document.hidden) return;
    // Excess automatic intersections remain tappable instead of producing a large queue.
    if (pending.current.length >= 12) return;
    load.disabled = true;
    load.closest(".kb-image")!.querySelector(".kb-image-result")!.textContent = "正在加载图片…";
    pending.current.push(load); pump.current();
  }, []);
  useEffect(() => {
    if (!active || !root.current) return;
    const observer = globalThis.IntersectionObserver ? new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting && !cached.current.has(entry.target)) {
        const button = entry.target.querySelector<HTMLButtonElement>("[data-local-image]");
        if (button) loadImage(button);
      }
    }, { rootMargin: "160px" }) : null;
    root.current.querySelectorAll("[data-local-image]").forEach(button => observer?.observe(button.closest(".kb-image")!));
    const stop = () => {
      ++current.current.epoch;
      root.current?.querySelectorAll<HTMLButtonElement>("[data-local-image]").forEach(button => {
        button.disabled = false;
        const status = button.closest(".kb-image")?.querySelector(".kb-image-result");
        if (status) status.textContent = "";
      });
      pending.current = []; decodeCancel.current.forEach(cancel => cancel());
      for (const [box, image] of cached.current) release(box, image);
    };
    const visibility = () => {
      if (document.hidden) { observer?.disconnect(); stop(); }
      else {
        root.current?.querySelectorAll("[data-local-image]").forEach(button => observer?.observe(button.closest(".kb-image")!));
        pump.current();
      }
    };
    document.addEventListener("visibilitychange", visibility);
    return () => { observer?.disconnect(); stop(); document.removeEventListener("visibilitychange", visibility); };
  }, [active, content, loadImage, release, root]);
  return loadImage;
}
