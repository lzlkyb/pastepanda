import { useEffect, useRef } from "react";

type Layer = { id: string; persistent: boolean; installed: boolean; priority: number; onBack: () => void };
const layers: Layer[] = [];
let removing = false;
let currentEntry: string | undefined;

function pushLayer(layer: Layer) {
  history.pushState({ ...history.state, mobileBackLayer: layer.id }, "");
  currentEntry = layer.id;
  layer.installed = true;
}

function installPending() {
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
  const layer = layers.filter(item => item.installed).reduce<Layer | undefined>(
    (top, item) => !top || item.priority >= top.priority ? item : top, undefined,
  );
  const departed = layers.find(item => item.id === currentEntry);
  if (departed) departed.installed = false;
  currentEntry = history.state?.mobileBackLayer;
  if (!layer) return;
  if (layer.persistent) {
    if (currentEntry !== layer.id) pushLayer(layer);
    else layer.installed = true;
  } else {
    layer.installed = false;
    layers.splice(layers.indexOf(layer), 1);
    skipOrphans();
  }
  layer.onBack();
}

/** 历史回收与新弹层入栈串行，避免切换弹层时异步 back 同时关闭新弹层。 */
export function useMobileBack(enabled: boolean, onBack: () => void, persistent = false, priority = 0) {
  const callback = useRef(onBack);
  callback.current = onBack;
  useEffect(() => {
    if (!enabled) return;
    if (layers.length === 0) window.addEventListener("popstate", onPop);
    const layer: Layer = { id: crypto.randomUUID(), persistent, installed: false, priority, onBack: () => callback.current() };
    layers.push(layer);
    if (!removing) installPending();
    return () => {
      const index = layers.indexOf(layer);
      if (index >= 0) layers.splice(index, 1);
      if (layer.installed && history.state?.mobileBackLayer === layer.id && !removing) {
        removing = true;
        history.back();
      }
      // 尚有异步回收时保留监听，最后的 pop 到达后不再留全局监听。
      if (layers.length === 0 && !removing) window.removeEventListener("popstate", onPop);
    };
  }, [enabled, persistent, priority]);
}
