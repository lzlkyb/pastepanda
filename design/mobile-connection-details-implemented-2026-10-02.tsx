import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { RcStatus } from "../src/lib/api/rcTypes";
import { RcMobileSession } from "../src-mobile/session/RcMobileSession";
import "../src/styles/theme.css";
import "../src-mobile/styles/mobile-base.css";

// Actual session components with an isolated native-command shim: no devices, files or settings are accessed.
const scene = new URLSearchParams(location.search).get("scene") ?? "normal";
const id = "connection-demo";
let callback = 0;
let jpeg = new Uint8Array();
let lastFrame = 0;
const makeStatus = () => ({ session: { id, phase: "outbound_active" }, quality: "auto", rtt_ms: scene === "waiting" ? 0 : scene === "slow" ? 240 : 36,
  pong_age_ms: scene === "recovering" ? 7000 : scene === "waiting" ? null : 80, path_kind: scene === "waiting" ? "" : scene === "slow" ? "relay" : "lan", clock_skew_ms: 10,
  loss_permille: scene === "slow" ? 16 : 0 }) as RcStatus;

function batch() {
  if (!jpeg.length || scene === "waiting" || Date.now() - lastFrame < (scene === "slow" ? 56 : 33)) return new ArrayBuffer(0);
  lastFrame = Date.now();
  const bytes = new Uint8Array(52 + jpeg.length);
  bytes.set([0x52, 0x43, 0x46, 0x32]);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 1, true); view.setUint8(9, 1); view.setUint8(10, 1);
  view.setBigInt64(12, BigInt(Date.now() + 10 - (scene === "slow" ? 280 : 58)), true);
  view.setUint16(20, 8, true); view.setUint16(22, 12, true);
  view.setUint32(24, 1440, true); view.setUint32(28, 900, true);
  view.setUint32(48, jpeg.length, true); bytes.set(jpeg, 52);
  return bytes.buffer;
}
(window as any).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "preview" }, currentWebview: { label: "preview" } },
  transformCallback: () => ++callback, unregisterCallback: () => {},
  invoke: async (command: string) => {
    if (command === "rc_drain_frames") return batch();
    if (command === "plugin:event|listen") return ++callback;
    if (command === "plugin:window|is_visible") return true;
    if (command === "plugin:event|unlisten" || command === "rc_send_input") return;
    if (command === "rc_cursor_poll") return null;
    throw new Error("隔离预览不执行真实操作。");
  },
};
(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };

function Sample() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState(makeStatus);
  useEffect(() => {
    const canvas = document.createElement("canvas"); canvas.width = 1440; canvas.height = 900;
    const cx = canvas.getContext("2d"); if (!cx) return;
    const vars = getComputedStyle(document.documentElement);
    cx.fillStyle = vars.getPropertyValue("--section-bg").trim(); cx.fillRect(0, 0, 1440, 900);
    cx.fillStyle = vars.getPropertyValue("--card-bg").trim(); cx.fillRect(100, 100, 1240, 680);
    cx.fillStyle = vars.getPropertyValue("--text-primary").trim();
    cx.font = "42px sans-serif"; cx.fillText("工作电脑 · 示例画面", 160, 200);
    cx.font = "28px sans-serif"; cx.fillText("点手机顶部的延时，查看本次连接详情。", 160, 270);
    cx.font = "26px sans-serif"; cx.fillText("所有读数与视频来自本地模拟，不是当前连接实测。", 160, 360);
    cx.fillText("关闭面板后继续控制；更多里也能找到连接详情。", 160, 420);
    void new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.85)).then(async blob => { if (blob) jpeg = new Uint8Array(await blob.arrayBuffer()); });
  }, []);
  useEffect(() => {
    let timer: number | undefined;
    const visibility = () => {
      window.clearInterval(timer);
      if (document.visibilityState === "visible") timer = window.setInterval(() => setStatus(makeStatus()), 2000);
    };
    visibility(); document.addEventListener("visibilitychange", visibility);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", visibility); };
  }, []);
  return <RcMobileSession title="工作电脑 · 示例" subtitle="控制中" sessionId={id} status={status} qualityHint="auto" canvasRef={canvasRef} onEnd={() => location.reload()} />;
}
createRoot(document.getElementById("root")!).render(<Sample />);
