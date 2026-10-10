import { useEffect, useRef, type RefObject } from "react";
import { configureNativeBack, listenNativeBack } from "./nativeInteraction";
import { createSceneMotion } from "./mobileSceneMotion";

type Layer = { id: string; persistent: boolean; installed: boolean; priority: number; onBack: () => void; preview?: () => HTMLElement | null };
const layers: Layer[] = [];
let removing = false;
let currentEntry: string | undefined;
let stopNative: (() => void) | undefined;
let nativeGesture: string | undefined;
let pendingNative: string | undefined;
let preview: { id: string; motion?: ReturnType<typeof createSceneMotion>; source?: HTMLElement; sourceInert?: boolean } | undefined;
let canceling: { motion: ReturnType<typeof createSceneMotion>; timer: number } | undefined;

function topLayer() {
  return layers.filter(item => item.installed).reduce<Layer | undefined>(
    (top, item) => !top || item.priority >= top.priority ? item : top, undefined,
  );
}
function resetPreview(cancel = false) {
  if (canceling) { window.clearTimeout(canceling.timer); canceling.motion.dispose(); canceling = undefined; }
  const previous = preview; preview = undefined;
  delete document.body.dataset.mobileBack;
  if (previous?.source) { delete previous.source.dataset.previewSource; previous.source.inert = previous.sourceInert ?? false; }
  if (cancel) previous?.motion?.cancelPreview();
  // Cancellation animation owns only its DOM node, never a history operation.
  if (cancel && previous?.motion) {
    const motion = previous.motion;
    canceling = { motion, timer: window.setTimeout(() => { motion.dispose(); canceling = undefined; }, 200) };
  }
  else previous?.motion?.dispose();
}
function syncNative() {
  configureNativeBack(layers.length > 0);
  if (!layers.length) { stopNative?.(); stopNative = undefined; resetPreview(); nativeGesture = undefined; return; }
  if (stopNative) return;
  stopNative = listenNativeBack(event => {
    if (event.phase === "start") {
      if (pendingNative) return;
      resetPreview();
      window.dispatchEvent(new Event("mobile-interaction-cancel"));
      const layer = topLayer();
      if (!layer) return;
      nativeGesture = layer.id;
      const element = layer.preview?.();
      const source = element?.closest<HTMLElement>("[data-mobile-task-root]") ?? element ?? undefined;
      preview = { id: layer.id, motion: element ? createSceneMotion(element) : undefined, source, sourceInert: source?.inert };
      document.body.dataset.mobileBack = "true";
      if (source) { source.dataset.previewSource = "true"; source.inert = true; }
    } else if (event.phase === "progress") preview?.motion?.preview(event.progress, event.edge);
    else if (event.phase === "cancel") { resetPreview(true); nativeGesture = undefined; }
    else {
      const valid = !!nativeGesture && nativeGesture === topLayer()?.id;
      nativeGesture = undefined;
      resetPreview();
      // Native preview is side-effect free; only a committed, still-current target pops history.
      if (valid && !removing && !pendingNative && topLayer()) { pendingNative = topLayer()!.id; history.back(); }
    }
  });
}

function pushLayer(layer: Layer) {
  history.pushState({ ...history.state, mobileBackLayer: layer.id }, "");
  currentEntry = layer.id;
  layer.installed = true;
}

function installPending() {
  // pushState during the browser's async Back traversal would redirect it to a newer sheet.
  if (pendingNative) return;
  for (const layer of layers) {
    if (layer.installed) continue;
    pushLayer(layer);
  }
}
function skipOrphans() {
  const id = history.state?.mobileBackLayer;
  currentEntry = id;
  if (id && !layers.some((layer) => layer.id === id)) {
    removing = true;
    history.back();
  } else {
    installPending();
    if (layers.length === 0) window.removeEventListener("popstate", onPop);
  }
}
function onPop() {
  if (removing) {
    removing = false;
    skipOrphans();
    return;
  }
  if (history.state?.mobileBackLayer === currentEntry) return;
  // React runs child effects before parent effects. Registration time cannot
  // decide whether a page destination outranks its details or open sheet.
  const committed = pendingNative; pendingNative = undefined;
  const layer = committed ? layers.find(item => item.id === committed) : topLayer();
  const departed = layers.find(item => item.id === currentEntry);
  if (departed) departed.installed = false;
  currentEntry = history.state?.mobileBackLayer;
  if (!layer) { skipOrphans(); syncNative(); return; }
  if (layer.persistent) {
    if (currentEntry !== layer.id) pushLayer(layer);
    else layer.installed = true;
  } else {
    layer.installed = false;
    layers.splice(layers.indexOf(layer), 1);
    skipOrphans();
  }
  layer.onBack();
  if (!removing) installPending();
  syncNative();
}

/** 历史回收与新弹层入栈串行，避免切换弹层时异步 back 同时关闭新弹层。 */
export function useMobileBack(enabled: boolean, onBack: () => void, persistent = false, priority = 0, previewRef?: RefObject<HTMLElement | null>) {
  const callback = useRef(onBack);
  callback.current = onBack;
  useEffect(() => {
    if (!enabled) return;
    if (layers.length === 0) window.addEventListener("popstate", onPop);
    const layer: Layer = { id: crypto.randomUUID(), persistent, installed: false, priority, onBack: () => callback.current(), preview: () => previewRef?.current ?? null };
    layers.push(layer);
    if (!removing) installPending();
    syncNative();
    return () => {
      const index = layers.indexOf(layer);
      if (index >= 0) layers.splice(index, 1);
      if (layer.installed && history.state?.mobileBackLayer === layer.id && !removing && !pendingNative) {
        removing = true;
        history.back();
      }
      // 尚有异步回收时保留监听，最后的 pop 到达后不再留全局监听。
      if (layers.length === 0 && !removing && !pendingNative) window.removeEventListener("popstate", onPop);
      if (preview?.id === layer.id) resetPreview();
      syncNative();
    };
  }, [enabled, persistent, priority, previewRef]);
}
