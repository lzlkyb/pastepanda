/**
 * AiStatusCap.tsx —— v6.4 主窗口 AI 感知（方案 A）：TopBar AI 胶囊。
 *
 * 三态一一对应（状态来自唯一判定 @/lib/aiAvailability，本组件不自己算）：
 * - off   「✦ 开启 AI」引流入口（accent 虚线描边）；
 * - nokey 「✦ AI 待配置」警示色——已启用但缺密钥，此时**绝不能写「就绪」**，
 *   否则用户以为能用，一点就报错；
 * - on    **已配置即隐**（审查方案 1：顶部零占用）——就绪状态收进设置按钮的小绿点，
 *   hover 才看详情；AI 能力入口由快捷区（复制即用）承担，功能一个不少。
 * 需要引导的状态（off/nokey）保留胶囊；点击跳设置 AI tab（走共享的 openAiSettings）。
 *
 * v6.9 追加：当前是内置免费服务商且额度耗尽 → 「✦ 余额不足」amber 警示胶囊
 * （异常态，非常驻；点击打开免费额度签到弹窗）。
 */
import { memo, useEffect, useState } from "react";
import { Sparkles, AlertTriangle } from "lucide-react";
import { AiMark } from "@/components/ai/AiMark";
import { useAiStatus } from "@/hooks/useAiStatus";
import { aiAwarenessActive } from "@/lib/aiAwareness";
import { openAiSettings } from "@/lib/openAiSettings";
import { useDialogStore } from "@/stores/dialogStore";
import { aiGetConfig } from "@/lib/api/ai";
import { aiQuotaGet } from "@/lib/api/quota";
import { BUILTIN_AGNES_ID, onQuotaChanged } from "@/lib/quota";
import styles from "./AiStatusCap.module.css";

export const AiStatusCap = memo(function AiStatusCap() {
  const { status, model } = useAiStatus();
  // 引导期：更新后 1 周内显示，过期自动隐藏（不长期占 TopBar 空间）
  const [aware, setAware] = useState(false);
  // v6.9：内置免费额度耗尽（仅在当前服务商是内置免费时判定）
  const [quotaEmpty, setQuotaEmpty] = useState(false);
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
  // 额度不足判定：仅当内置免费为当前服务商时检查（异常态非常驻）。
  // v6.9 缺陷修复：监听额度变更事件（签到/兑换后刷新，不用重启才消失）
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const cfg = await aiGetConfig();
        if (cfg.provider !== BUILTIN_AGNES_ID) {
          if (alive) setQuotaEmpty(false);
          return;
        }
        const q = await aiQuotaGet();
        if (alive) setQuotaEmpty(q.remaining <= 0);
      } catch {
        /* 读不到就当作不空 */
      }
    };
    void refresh();
    const off = onQuotaChanged(() => void refresh());
    return () => {
      alive = false;
      off();
    };
  }, []);
  if (!aware) return null;

  // 判定未回来前先占位：胶囊异步就绪后直接插进 TopBar 会把右侧图标挤一下，
  // 骨架尺寸与真胶囊一致，布局就不会跳
  if (status === "loading") return <span className={styles.skeleton} aria-hidden />;

  if (quotaEmpty) {
    return (
      <AiMark
        shape="cap"
        tone="warn"
        icon={<AlertTriangle size={11} />}
        text="余额不足"
        title="免费额度已用完：签到或兑换后继续使用。点击打开免费额度"
        onClick={() => useDialogStore.getState().openQuota()}
      />
    );
  }

  if (status === "off") {
    return (
      <AiMark
        shape="cap"
        tone="brand"
        icon={<Sparkles size={11} />}
        text="AI"
        title="开启 AI：翻译 / 总结 / 改写 / 脱敏 / 链接摘要"
        onClick={() => void openAiSettings()}
      />
    );
  }

  if (status === "nokey") {
    return (
      // 这里用 warn 而不是 brand：已启用但缺密钥是「还差一步」，
      // 换成品牌蓝紫会让用户以为能用了，一点就报错
      <AiMark
        shape="cap"
        tone="warn"
        icon={<AlertTriangle size={11} />}
        text="AI"
        title={`AI 已启用但还不能用：${model} 缺 API Key（密钥按服务商分开存，刚切过服务商就要重新填）。点此去填`}
        onClick={() => void openAiSettings()}
      />
    );
  }

  // 已配置（on）：顶部零占用——状态收进设置按钮小绿点（AiStatusDot），这里不渲染
  return null;
});
