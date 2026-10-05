/**
 * rcErrorText — 设备页错误文案的人话翻译（U55 同判据，规则 11 收口一处）。
 *
 * store/命令抛上来的错误有两类：后端给的已是人话（原样展示）；前端/环境
 * 的技术串（无 Tauri、IPC 断、网络超时）必须翻译。技术细节一律进日志。
 */
import { permissionErrorInfo, type PermissionContext } from "@/lib/utils";

export function rcErrorText(e: unknown, context: PermissionContext = "general"): string {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e || "");
  const low = raw.toLowerCase();
  if (context === "file-receive" && /对方|电脑|peer|remote/i.test(raw) && /拒绝|denied|declined/i.test(raw) && !/permission|权限/i.test(raw)) {
    return "电脑没有同意发送文件。请在电脑端 PastePanda 的文件请求中确认并选择文件，然后在手机上重新取文件。";
  }
  const permission = permissionErrorInfo(e, context);
  if (permission) {
    console.warn("[rc] 操作未获允许", raw);
    return `${permission.title}。${permission.detail}`;
  }
  // 保留原文给日志/控制台
  if (raw.length > 0 && (low.includes("invoke") || low.includes("tauri_internal"))) {
    console.warn("[rc] 后台调用失败", raw);
    return "无法连接应用后台，请在 PastePanda 应用内使用";
  }
  if (low.includes("timeout") || low.includes("network") || low.includes("socket")) {
    console.warn("[rc] 网络失败", raw);
    return "网络连接失败，请检查两台设备的网络后重试";
  }
  // Unknown diagnostics may contain paths or credentials. Only human-facing Chinese
  // messages survive this boundary; callers never need to inspect exception strings.
  const message = e instanceof Error ? e.message : raw;
  const diagnostic = /https?:|file:\/\/|[a-z]:[\\/]|\\\\|\/(?:storage|data|users|home|tmp)\/|\b(?:token|password|secret|stack|exception)\b|(?:密码|密钥|口令)\s*[:=]|PPU-|PP-[a-z0-9]{4}-[a-z0-9]{4}|\bat\s+\w+\s*\(/i;
  if (/[\u4e00-\u9fff]/.test(message) && !diagnostic.test(message)) return message;
  return "操作未能完成，请重试；如果仍然失败，请检查连接状态";
}
