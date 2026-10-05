import React from "react";
import { createRoot } from "react-dom/client";
import App from "../../src-mobile/App";
import "../../src/styles/theme.css";
import "../../src-mobile/styles/mobile-base.css";

// Actual mobile components, with isolated in-memory IPC samples. No native calls or remote connection.
const targets = [
  { node_id: "preview-pc", name: "工作电脑 · 示例", os: "windows", presence: "live", last_path: "lan" },
  { node_id: "preview-mac", name: "MacBook Air · 示例", os: "macos", presence: "recent", last_path: "direct" },
  { node_id: "preview-pad", name: "iPad Air · 示例", os: "ipados", presence: "recent", last_path: "" },
].map(item => ({ ...item, display_name: item.name, source: "rc", denied: false, conn_state: "online", last_seen: Date.now() }));
const status = { enabled: true, running: true, capability: "control", quality: "balanced", capture_scope: "desktop", pending: [], joins: [], device_deny: {}, session: null };
let callbackId = 0;
const mockWindow = window as unknown as {
  __TAURI_INTERNALS__: unknown;
  __TAURI_EVENT_PLUGIN_INTERNALS__: unknown;
};
mockWindow.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "preview" }, currentWebview: { label: "preview" } },
  transformCallback: () => ++callbackId,
  unregisterCallback: () => {},
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "rc_status") return { ...status };
    if (command === "rc_targets") return targets;
    if (command === "rc_identity") return { node_id: "preview-phone", fingerprint: "PREVIEW-ONLY", device_name: "手机 · 示例", running: true };
    if (command === "rc_probe_targets") return { "preview-pc": true, "preview-mac": false, "preview-pad": false };
    if (command === "rc_file_snapshot") return { asks: [], tasks: [{ id: "preview-task", peer: "preview-pc", peer_name: targets[0].name, dir: "send", name: "产品说明.pdf · 示例", size: 1000000, offset: 0, done: 620000, state: "transferring", started_ms: Date.now(), updated_ms: Date.now() }] };
    if (command === "rc_file_default_dir") return "手机 / Downloads / PastePanda（示例）";
    if (command === "rc_session_history" || command === "rc_sync_offers") return [];
    if (command === "rc_short_pair_code") return { code: "20266322", expires_at: Date.now() + 120000 };
    if (command === "rc_set_enabled") { status.enabled = Boolean(args.enable); status.running = status.enabled; return; }
    if (command === "plugin:event|listen") return ++callbackId;
    if (command === "plugin:event|unlisten" || command === "rc_short_pair_cancel") return;
    if (command === "plugin:window|is_visible") return true;
    throw new Error("本地预览不执行此操作，请在真实手机验证。");
  },
};
mockWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
