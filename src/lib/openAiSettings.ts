/**
 * lib/openAiSettings.ts —— v6.4 主窗口 AI 感知：跳转设置 AI tab 的唯一入口。
 * 通过 tauri 事件 open-ai-settings（App 已监听并定位到 AI tab），
 * 供 AiStatusCap / AiQuickBar / TransformCard 共用，避免各写一份 emit。
 */
export async function openAiSettings(): Promise<void> {
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit("open-ai-settings");
  } catch {
    /* 事件失败不打扰 */
  }
}
