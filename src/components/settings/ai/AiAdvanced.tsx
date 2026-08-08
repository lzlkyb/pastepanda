/**
 * 高级设置（默认折叠）。
 *
 * 放进来的标准：**不填也能跑起来的东西**。服务商、模型、密钥都在主流程
 * （见 AiSetupStep）——模型也包括手填，所以这里不再重复一份。
 */

import { ChevronDown, ChevronRight } from "lucide-react";
import type { AiConfig, AiProviderInfo } from "@/lib/api";
import settings from "../../Settings.module.css";
import styles from "../AiTab.module.css";

interface Props {
  open: boolean;
  onToggle: () => void;
  config: AiConfig;
  spec: AiProviderInfo | null;
  hasKey: boolean;
  onDraft: (patch: Partial<AiConfig>) => void;
  onCommit: () => void;
  /** 开关类的改动要立即落盘，不等失焦 */
  onSave: (patch: Partial<AiConfig>) => void;
  onClearKey: () => void;
}

export function AiAdvanced(p: Props) {
  const { config, spec } = p;
  const isLocal = !!spec && !spec.needsKey;

  return (
    <div className={styles.advanced}>
      <button className={styles.advancedToggle} onClick={p.onToggle}>
        {p.open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        高级设置
        <span className={styles.advancedHint}>接口地址、协议、超时、费用上限</span>
      </button>

      {!p.open ? null : (
        <div className={styles.advancedBody}>
          <label className={styles.field}>
            <span className={styles.label}>接口地址</span>
            <input
              className={styles.input}
              value={config.baseUrl}
              placeholder={spec?.baseUrl || "https://你的中转地址/v1"}
              onChange={(e) => p.onDraft({ baseUrl: e.target.value })}
              onBlur={p.onCommit}
            />
            <span className={styles.hint}>留空则用厂商默认地址。填中转服务时写到 /v1 为止。</span>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>接口协议</span>
            <select
              className={styles.select}
              value={config.protocol}
              onChange={(e) => p.onSave({ protocol: e.target.value })}
            >
              <option value="">
                厂商默认（{spec?.protocol === "anthropic" ? "Anthropic" : "OpenAI 兼容"}）
              </option>
              <option value="openai">OpenAI 兼容 · /chat/completions</option>
              <option value="anthropic">Anthropic Messages · /messages</option>
            </select>
            <span className={styles.hint}>
              同一家常常两种都提供（如智谱），中转服务更是如此。选错时的典型症状是 404。
            </span>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>请求超时（秒）</span>
            <input
              className={styles.input}
              type="number"
              min={5}
              max={300}
              value={config.timeoutSecs}
              onChange={(e) => p.onDraft({ timeoutSecs: Number(e.target.value) || 60 })}
              onBlur={p.onCommit}
            />
            <span className={styles.hint}>太短会把正常回答切断，太长等于卡界面。默认 60 秒。</span>
          </label>

          {!isLocal && (
            <label className={styles.field}>
              <span className={styles.label}>每日费用上限（元）</span>
              <input
                className={styles.input}
                type="number"
                min={0}
                step={1}
                value={config.dailyBudgetCny}
                onChange={(e) => p.onDraft({ dailyBudgetCny: Number(e.target.value) || 0 })}
                onBlur={p.onCommit}
              />
              <span className={styles.hint}>
                填 0 表示不限制。这个数字基于<strong>估算</strong>单价，用来拦住失控的连续调用，
                不是对账；真实金额以服务商账单为准。
              </span>
            </label>
          )}

          <div className={styles.field}>
            <span className={styles.label}>启用 AI 动作</span>
            <div className={styles.row}>
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={(e) => p.onSave({ enabled: e.target.checked })}
              />
              <span className={styles.hint}>
                关闭时变换中心不会出现 AI 分组。测试通过时会自动打开。
              </span>
            </div>
          </div>

          {p.hasKey && (
            <div className={styles.row}>
              <button className={settings.btnDanger} onClick={p.onClearKey}>
                删除这家的密钥
              </button>
              <span className={styles.hint}>只删 {spec?.name ?? "当前服务商"} 的，其他家不受影响。</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
