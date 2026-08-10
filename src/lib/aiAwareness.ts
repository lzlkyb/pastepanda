/**
 * lib/aiAwareness.ts —— v6.4 主窗口 AI 感知（引导期策略）。
 *
 * AI 胶囊 / 快捷区只在「新版本更新后的第一周」显示，之后自动隐藏（不长期占顶部空间）。
 * 规则：记录每个版本的首次显示时间；版本变化 → 重新开始 1 周窗口；同版本超过 7 天 → 隐藏。
 * 存储异常时默认显示（不能因为 localStorage 不可用就把引导功能藏掉）。
 */
const KEY_VER = "pastepanda_ai_aware_ver";
const KEY_AT = "pastepanda_ai_aware_at";
const WINDOW_MS = 7 * 24 * 3600 * 1000;

export const AI_AWARENESS_WINDOW_DAYS = 7;

/** 当前版本是否处于 AI 感知引导期（1 周内） */
export function aiAwarenessActive(appVersion: string): boolean {
  if (!appVersion || appVersion === "?.?.?") return false;
  try {
    const ver = localStorage.getItem(KEY_VER);
    const at = Number(localStorage.getItem(KEY_AT) || 0);
    if (ver !== appVersion) {
      // 新版本（或首次）：重置 1 周窗口
      localStorage.setItem(KEY_VER, appVersion);
      localStorage.setItem(KEY_AT, String(Date.now()));
      return true;
    }
    return Date.now() - at < WINDOW_MS;
  } catch {
    return true;
  }
}
