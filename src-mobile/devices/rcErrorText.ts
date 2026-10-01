/**
 * rcErrorText — 设备页错误文案的人话翻译（U55 同判据，规则 11 收口一处）。
 *
 * store/命令抛上来的错误有两类：后端给的已是人话（原样展示）；前端/环境
 * 的技术串（无 Tauri、IPC 断、网络超时）必须翻译。技术细节一律进日志。
 */
export function rcErrorText(e: unknown): string {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e || "");
  const low = raw.toLowerCase();
  // 保留原文给日志/控制台
  if (raw.length > 0 && (low.includes("invoke") || low.includes("tauri_internal"))) {
    console.warn("[rc] 后台调用失败", raw);
    return "无法连接应用后台，请在 PastePanda 应用内使用";
  }
  if (low.includes("timeout") || low.includes("network") || low.includes("socket")) {
    console.warn("[rc] 网络失败", raw);
    return "网络连接失败，请检查两台设备的网络后重试";
  }
  if (low.includes("denied") || low.includes("permission")) {
    console.warn("[rc] 权限不足", raw);
    return "操作权限不足，请检查系统设置";
  }
  return raw || "操作失败，请重试";
}
