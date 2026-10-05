import { createRoot } from "react-dom/client";
import App from "../src-mobile/App";
import "../src/styles/theme.css";
import "../src-mobile/styles/mobile-base.css";

// Actual App, isolated in-memory commands: no remote connection, camera, real file or settings access.
const target = { node_id: "demo-pc", name: "工作电脑 · 示例", display_name: "工作电脑 · 示例", os: "windows", presence: "live", source: "rc", denied: false, conn_state: "online", last_seen: Date.now() };
const status = { enabled: true, running: true, capability: "control", quality: "balanced", pending: [], joins: [], session: null };
let counter = 0, reset = false;
(window as any).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "preview" }, currentWebview: { label: "preview" } },
  transformCallback: () => ++counter, unregisterCallback: () => {},
  invoke: async (command: string) => {
    if (command === "rc_status") return status;
    if (command === "rc_targets") return [target];
    if (command === "rc_identity") return { node_id: "demo-phone", fingerprint: "PREVIEW-ONLY", device_name: "手机 · 示例", running: true };
    if (command === "rc_probe_targets") return { "demo-pc": true };
    if (command === "rc_file_snapshot") return { asks: [], tasks: [] };
    if (command === "rc_file_default_dir") return reset ? "手机应用下载目录 / PastePanda 接收（示例）" : "不可写的接收位置（示例）";
    if (command === "rc_file_receive_dir_set") { reset = true; return "手机应用下载目录 / PastePanda 接收（示例）"; }
    if (command === "rc_file_pull") { if (!reset) throw new Error("接收目录无法创建：Permission denied (os error 13)"); return; }
    if (command === "rc_session_history" || command === "rc_sync_offers") return [];
    if (command === "plugin:event|listen") return ++counter;
    if (command === "plugin:event|unlisten") return;
    if (command === "plugin:window|is_visible") return true;
    throw new Error("本地示例不执行此操作。");
  },
};
(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
createRoot(document.getElementById("root")!).render(<App/>);
