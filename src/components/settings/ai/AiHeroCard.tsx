/**
 * AI 设置页顶部的**状态摘要卡**（方案 B）。
 *
 * 一屏回答三个问题：现在能不能用、今天花了多少、免费额度还剩多少。
 * 改之前这三个数字分散在 statusBar / cfgHead / AiUsageCard / QuotaEntryCard
 * 四个区块里，而 statusBar 那句“当前使用 XXX”与 cfgHead 完全重复。
 */

import type { ReactNode } from "react";
import { CheckCircle2, Circle, Gift, Loader2, PauseCircle, Repeat, Zap } from "lucide-react";
import type { AiConfig, AiProviderInfo, AiUsage } from "@/lib/api";
import type { QuotaInfo } from "@/lib/api/quota";
import { fmtWan } from "@/lib/quota";
import styles from "../AiTab.module.css";

interface Props {
  spec: AiProviderInfo | null;
  config: AiConfig;
  configured: boolean;
  isLocal: boolean;
  usage: AiUsage | null;
  quota: QuotaInfo | null;
  testing: boolean;
  onTest: () => void;
  /** 展开“服务商与密钥”区块（未配置时的主按钮、已配置时的“换服务商”） */
  onOpenSetup: () => void;
  onOpenQuota: () => void;
}

/** 一个数字格。value 允许带小单位（¥ / k），所以收 ReactNode。 */
function Stat({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div className={styles.heroStat}>
      <div className={styles.heroStatNum}>{value}</div>
      <div className={styles.heroStatLabel}>{label}</div>
    </div>
  );
}

export function AiHeroCard(p: Props) {
  const { spec, config, configured, isLocal, usage, quota, testing } = p;

  const name = configured ? (spec?.name ?? config.provider) : "未配置 AI";
  const model = configured
    ? config.model || spec?.models?.[0]?.id || "…"
    : "选一家服务商开始，变换中心就会多出四个 AI 动作";

  // 状态徽标区分三种情况：未配置 / 已配置但停用 / 已就绪。
  // “已配置但未启用”必须单独有个态：否则用户会对着一张看起来正常的卡
  // 纳闷为什么变换中心里没有 AI 分组。
  const badge = !configured ? (
    <span className={`${styles.badge} ${styles.badgeIdle}`}>
      <Circle size={10} /> 未配置
    </span>
  ) : config.enabled ? (
    <span className={`${styles.badge} ${styles.badgeReady}`}>
      <CheckCircle2 size={10} /> 已就绪
    </span>
  ) : (
    <span className={`${styles.badge} ${styles.badgeOff}`}>
      <PauseCircle size={10} /> 已停用
    </span>
  );

  // 数字格按条件拼，再用长度算列数——固定 repeat(3) 的话，
  // 本地模型或拉不到额度时会留下一个空格子。
  const stats: { value: ReactNode; label: string }[] = [];
  if (usage) {
    stats.push({ value: usage.calls, label: "今日调用" });
    if (isLocal) {
      stats.push({
        value: <>{usage.promptTokens + usage.completionTokens}</>,
        label: "今日 token",
      });
    } else {
      stats.push({
        value: (
          <>
            <small>¥</small>
            {usage.costCny.toFixed(2)}
          </>
        ),
        label: usage.budgetCny > 0 ? `今日花费 / ¥${usage.budgetCny.toFixed(0)}` : "今日花费",
      });
    }
  }
  if (quota) {
    stats.push({ value: fmtWan(quota.remaining), label: "免费额度剩余" });
  }

  return (
    <div className={styles.heroCard}>
      <div className={styles.heroTop}>
        <span className={styles.heroAvatar}>{configured ? (spec?.name?.[0] ?? "AI") : "✦"}</span>
        <span className={styles.heroTitles}>
          <span className={styles.heroName}>
            {name}
            {badge}
          </span>
          <span className={styles.heroModel}>{model}</span>
        </span>
      </div>

      {stats.length > 0 && (
        <div
          className={styles.heroStats}
          style={{ gridTemplateColumns: `repeat(${stats.length}, 1fr)` }}
        >
          {stats.map((s) => (
            <Stat key={s.label} value={s.value} label={s.label} />
          ))}
        </div>
      )}

      <div className={styles.heroActions}>
        {configured ? (
          <>
            <button className={styles.heroBtnMain} onClick={p.onTest} disabled={testing}>
              {testing ? <Loader2 size={12} className="spin" /> : <Zap size={12} />}
              {testing ? "测试中…" : "测试连接"}
            </button>
            <button className={styles.heroBtn} onClick={p.onOpenSetup}>
              <Repeat size={12} /> 换服务商
            </button>
          </>
        ) : (
          <button className={styles.heroBtnMain} onClick={p.onOpenSetup}>
            <Zap size={12} /> 开始配置
          </button>
        )}
        {quota && (
          <button className={styles.heroBtn} onClick={p.onOpenQuota}>
            <Gift size={12} /> 领免费额度
          </button>
        )}
      </div>
    </div>
  );
}
