/**
 * AiStatusCap.tsx —— v6.4 主窗口 AI 感知（方案 A）：TopBar AI 胶囊。
 *
 * 三态一一对应（状态来自唯一判定 @/lib/aiAvailability，本组件不自己算）：
 * - off   「✦ 开启 AI」引流入口（accent 虚线描边）；
 * - nokey 「✦ AI 待配置」警示色——已启用但缺密钥，此时**绝不能写「就绪」**，
 *   否则用户以为能用，一点就报错；
 * - on    「✦ AI 就绪」绿色胶囊，title 显示本周用量与模型（价值可见）。
 * 三态都点击跳设置 AI tab（走共享的 openAiSettings）。
 */
import { memo, useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { useAiStatus } from "@/hooks/useAiStatus";
import { aiAwarenessActive } from "@/lib/aiAwareness";
import { openAiSettings } from "@/lib/openAiSettings";
import styles from "./AiStatusCap.module.css";

export const AiStatusCap = memo(function AiStatusCap() {
  const { status, weekCalls, model } = useAiStatus();
  // 引导期：更新后 1 周内显示，过期自动隐藏（不长期占 TopBar 空间）
  const [aware, setAware] = useState(false);
  useEffect(() => {
    // 卸载守卫：版本号是异步拉的，回来时组件可能已经没了
    let alive = true;
    import("@/lib/api")
      .then((m) => m.getAppVersion())
      .then((v) => {
        if (alive) setAware(aiAwarenessActive(v));
      })
      .catch(() => {
        if (alive) setAware(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  if (!aware) return null;

  // 判定未回来前先占位：胶囊异步就绪后直接插进 TopBar 会把右侧图标挤一下，
  // 骨架尺寸与真胶囊一致，布局就不会跳
  if (status === "loading") return <span className={`${styles.cap} ${styles.loading}`} aria-hidden />;

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

  if (status === "nokey") {
    return (
      <button
        className={`${styles.cap} ${styles.nokey}`}
        onClick={() => void openAiSettings()}
        title={`AI 已启用但还不能用：${model} 缺 API Key（密钥按服务商分开存，刚切过服务商就要重新填）。点此去填`}
      >
        <Sparkles size={11} /> AI 待配置
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
