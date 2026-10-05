import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { useRcFile } from "../src/hooks/useRcFile";
import { useRcFileStore } from "../src/stores/rcFileStore";
import { RcMobileSession } from "../src-mobile/session/RcMobileSession";
import "../src/styles/theme.css";
import "../src-mobile/styles/mobile-base.css";

// Isolated sample: native commands are replaced; no real remote, files, or permissions are accessed.
let snapshot = { asks: [{ id: "demo-ask", peer: "demo-pc", peer_name: "工作电脑 · 示例", kind: "push", name: "产品说明.pdf · 示例", size: 2400000, first_seen_ms: Date.now() }], tasks: [] };
let callback = 0;
(window as any).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "preview" }, currentWebview: { label: "preview" } },
  transformCallback: () => ++callback, unregisterCallback: () => {},
  invoke: async (command: string) => {
    if (command === "rc_file_snapshot") return snapshot;
    if (command === "rc_file_default_dir") return "手机 / 下载 / PastePanda（示例）";
    if (command === "rc_file_respond") {
      snapshot = { asks: [], tasks: [] };
      useRcFileStore.getState().applySnapshot(snapshot);
      return;
    }
    if (command === "plugin:event|listen") return ++callback;
    if (command === "plugin:event|unlisten" || command === "rc_send_input") return;
    if (command === "plugin:window|is_visible") return true;
    throw new Error("此预览不执行真实操作。");
  },
};
(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
function Sample() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const file = useRcFile();
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = 1440; canvas.height = 900;
    const context = canvas.getContext("2d");
    if (!context) return;
    const colors = getComputedStyle(document.documentElement);
    context.fillStyle = colors.getPropertyValue("--section-bg").trim(); context.fillRect(0, 0, 1440, 900);
    context.fillStyle = colors.getPropertyValue("--text-primary").trim();
    context.font = "40px sans-serif"; context.fillText("远程画面 · 本地示例", 100, 180);
    context.font = "26px sans-serif"; context.fillText("文件请求在当前会话中处理，关闭面板后继续。", 100, 240);
  }, []);
  return <RcMobileSession title="工作电脑 · 示例" subtitle="控制中" canvasRef={canvasRef} contentSize={{ w: 1440, h: 900 }} file={file} onEnd={() => location.reload()} />;
}
createRoot(document.getElementById("root")!).render(<Sample />);
