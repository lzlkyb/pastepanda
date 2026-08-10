/**
 * AiStatusCap.tsx —— v6.4 主窗口 AI 感知（方案 A）：TopBar AI 胶囊。
 *
 * 未配置 → 「✦ 开启 AI」引流入口（accent 虚线描边，点击跳设置 AI tab）；
 * 已配置 → 「✦ AI 就绪」绿色胶囊，title 显示本周使用次数与模型（价值可见）。
 * 零配置用户第一眼就能看到 AI 入口，不再"软件有没有 AI 都不知道"。
 */
import { memo, useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { useAiStatus } from "@/hooks/useAiStatus";
import { aiAwarenessActive } from "@/lib/aiAwareness";
import styles from "./AiStatusCap.module.css";

/** 跳转设置 AI tab（复用 open-ai-settings 事件，App 已监听并定位 tab） */
async function openAiSettings() {
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit("open-ai-settings");
  } catch {
    /* 事件失败不打扰 */
  }
}

export const AiStatusCap = memo(function AiStatusCap() {
  const { status, weekCalls, model } = useAiStatus();
  // 引导期：更新后 1 周内显示，过期自动隐藏（不长期占 TopBar 空间）
  const [appVersion, setAppVersion] = useState("");
  const [aware, setAware] = useState(false);
  useEffect(() => {
    import("@/lib/api")
      .then((m) => m.getAppVersion().then((v) => {
        setAppVersion(v);
        setAware(aiAwarenessActive(v));
      }))
      .catch(() => setAware(false));
  }, []);
  if (!aware || status === "loading") return null;

  if (status === "off") {
    return (
      <button
        className={`${styles.cap} ${styles.off}`}
        onClick={() => void openAiSettings()}
        title="开启 AI：翻译 / 总结 / 改写 / 脱敏 / 链接摘要"
      >
        <Sparkles size={11} /> 开启 AI
      </button>
    );
  }

  return (
    <button
      className={`${styles.cap} ${styles.on}`}
      onClick={() => void openAiSettings()}
      title={`AI 已就绪 · 本周使用 ${weekCalls} 次 · ${model}`}
    >
      <Sparkles size={11} /> AI 就绪
    </button>
  );
});
