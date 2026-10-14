import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { applyTheme } from "../lib/theme";
import { getCurrentWindow } from "@tauri-apps/api/window";

// 唯一 IPC 边界。运动控制器只处理工作区逻辑坐标，物理坐标在这里转换一次。
export function createBridge() {
  let latest,
    unlisten = [];
  const notifyError = (error) =>
    document.dispatchEvent(new CustomEvent("clothesline-error", { detail: String(error) }));
  const safe = (promise) => promise.catch(notifyError);
  function logical(rect) {
    const { workArea, scale } = latest;
    return {
      x: (rect.x - workArea.x) / scale,
      y: (rect.y - workArea.y) / scale,
      width: rect.width / scale,
      height: rect.height / scale,
    };
  }
  function physical(rect) {
    const { workArea, scale } = latest;
    return {
      x: workArea.x + rect.x * scale,
      y: workArea.y + rect.y * scale,
      width: rect.width * scale,
      height: rect.height * scale,
    };
  }
  async function prepare(photo, retry = false) {
    const path = await invoke("get_image_thumbnail", { path: photo.path });
    const url = convertFileSrc(path) + (retry ? '?retry=' + Date.now() : '');
    const image = new Image();
    image.src = url;
    // 缩略图已写入不等于浏览器已解码；准备好再替换占位，避免先出现空相框。
    await image.decode();
    return { ...photo, aspect: photo.width / Math.max(1, photo.height), weight: 1, url };
  }
  return {
    safe,
    logical,
    physical,
    prepare,
    original: (photo) => invoke("get_image_data_url", { path: photo.path }),
    async snapshot() {
      latest = await invoke("clothesline_state");
      const config = await invoke("get_config");
      applyTheme(config.theme);
      return latest;
    },
    async subscribe(callbacks) {
      const registrations = [
        [
          "clothesline-update",
          (payload) => {
            latest = payload;
            callbacks.update(payload);
          },
        ],
        ["clothesline-visible", callbacks.visible],
        ["clothesline-hover", callbacks.hover],
        ["clothesline-pin-preview", callbacks.pinPreview],
        ["clothesline-pin-drop", callbacks.pinDrop],
        ["clothesline-pin-closed", callbacks.pinClosed],
        ["clothesline-preview-dismiss", callbacks.dismissPreview],
        ["theme-changed", (payload) => applyTheme(payload.theme)],
      ];
      for (const [name, run] of registrations) {
        unlisten.push(await listen(name, (e) => safe(Promise.resolve().then(() => run(e.payload)))));
      }
    },
    ready: () => invoke("clothesline_ready"),
    reportError: (message) => invoke("clothesline_report_error", { message }),
    focusPreview: () => getCurrentWindow().setFocus(),
    async photoForPin(pin, id) {
      const info = await invoke("get_image_info", { path: pin.path });
      return prepare({
        id: id || crypto.randomUUID(),
        path: pin.path,
        name: info.file_name,
        source: "桌面贴图",
        width: info.width,
        height: info.height,
      });
    },
    regions: (regions, dragging) => safe(invoke("clothesline_regions", { regions, dragging })),
    config: (config) => invoke("clothesline_config", { config }),
    remove: (ids) => invoke("clothesline_remove", { ids }),
    restore: (items) => invoke("clothesline_restore", { items }),
    order: (ids) => invoke("clothesline_order", { ids }),
    idle: () => safe(invoke("clothesline_idle")),
    take: (item, rect) => invoke("clothesline_take", { id: item.id, rect: physical(rect) }),
    dragTake: (item, rect) => invoke("clothesline_take", { id: item.id, rect: physical(rect), drag: true }),
    startDrag: (pin, rect, held, point) => {
      const cursor = point && physical({ ...point, width: 1, height: 1 });
      return invoke("clothesline_start_drag", { pin, rect: physical(rect), held, point: cursor ? [cursor.x, cursor.y] : null });
    },
    showPin: (pin) => invoke("clothesline_show_pin", { pin }),
    closePin: (pin) => invoke("clothesline_close_pin", { pin }),
    returnPin: (pin, id, slot) => invoke("clothesline_return_pin", { pin, id, slot }),
    manager: () => safe(invoke("open_pinned_panel")),
    dispose() {
      unlisten.forEach((off) => off());
      unlisten = [];
    },
  };
}
