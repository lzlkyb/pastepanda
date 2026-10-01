/**
 * 高级设置（默认折叠）。
 *
 * 放进来的标准：**不填也能跑起来的东西**。服务商、模型、密钥都在主流程
 * （见 AiSetupStep）——模型也包括手填，所以这里不再重复一份。
 */

import { Settings2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AiConfig, AiProviderInfo } from "@/lib/api";
import { AiSection } from "./AiSection";
import { AiSemanticField } from "./AiSemanticField";
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
  // v6.4 审查修复：#4 清空密钥二次确认（密钥不可恢复）
  const [confirmClear, setConfirmClear] = useState(false);

  // 折叠/卸载前先把草稿落盘：输入框靠 onBlur 提交，但折叠是卸载而非失焦，
  // React 不会触发 blur，未失焦的值会静默丢失（P1 修复）。
  //
  // ⚠️ 依赖只能是 [p.open]，**绝不能是 [p]**（曾经就是，酿成下面这个 bug）：
  // p 里有 AiTab 传的 inline 箭头（onToggle / onClearKey），每次 render 都是新对象，
  // 于是「卸载前落盘」退化成「每次 render 都落盘一次」；更糟的是 cleanup 捕获的是
  // **上一轮**的 onCommit，它闭包里是上一轮的 config。改任何一个开关都会被上一轮的
  // 旧值写回去，新旧值逐帧互相覆盖 —— 界面疯狂闪动、每帧几次 IPC，配置最终停在哪个值
  // 全看振荡被打断在哪一帧。面板刚打开、config 还是 DEFAULT_CONFIG 那一帧更直接把
  // 「未启用 + deepseek」写进库，用户看到的就是「我配好的 AI 自己没了」。
  //
  // onCommit 走 ref 而不是进依赖：它每次 config 变都是新引用，进依赖等于又回到上面那个坑。
  const commitRef = useRef(p.onCommit);
  useEffect(() => {
    commitRef.current = p.onCommit;
  }, [p.onCommit]);
  useEffect(() => {
    if (!p.open) return;
    // 只在「展开 → 收起」和「展开着卸载」这两个时刻落盘，落的是 ref 里的最新草稿
    return () => commitRef.current();
  }, [p.open]);

  return (
    <AiSection
      icon={<Settings2 size={13} />}
      title="高级设置"
      subtitle="接口地址、协议、超时、思考、费用上限"
      open={p.open}
      onToggle={p.onToggle}
    >
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

        {/* v6.4：协议下拉 → seg 切换（空值 = 厂商默认，高亮对应档；点击即覆盖） */}
        <div className={styles.field}>
          <span className={styles.label}>接口协议</span>
          <div className={styles.segs}>
            {(["openai", "anthropic"] as const).map((proto) => {
              const active =
                (config.protocol || spec?.protocol || "openai") === proto;
              return (
                <button
                  key={proto}
                  className={`${styles.seg}${active ? ` ${styles.segOn}` : ""}`}
                  onClick={() => p.onSave({ protocol: proto })}
                >
                  {proto === "openai" ? "OpenAI 兼容" : "Anthropic 协议"}
                </button>
              );
            })}
          </div>
          <span className={styles.hint}>
            同一家常常两种都提供（如智谱），中转服务更是如此。选错时的典型症状是 404。
          </span>
        </div>

        <label className={styles.field}>
          <span className={styles.label}>请求超时（秒）</span>
          <div className={styles.advInputRow}>
            <input
              className={styles.numInput}
              type="number"
              min={5}
              max={300}
              value={config.timeoutSecs}
              onChange={(e) => p.onDraft({ timeoutSecs: Number(e.target.value) || 60 })}
              onBlur={p.onCommit}
            />
            <span className={styles.hint}>太短会把正常回答切断，太长等于卡界面。默认 60 秒。</span>
          </div>
        </label>

        {!isLocal && (
          <label className={styles.field}>
            <span className={styles.label}>每日费用上限（元）</span>
            <div className={styles.advInputRow}>
              <input
                className={styles.numInput}
                type="number"
                min={0}
                step={1}
                value={config.dailyBudgetCny}
                onChange={(e) => p.onDraft({ dailyBudgetCny: Number(e.target.value) || 0 })}
                onBlur={p.onCommit}
              />
              <span className={styles.hint}>
                0 = 不限制。按<strong>估算</strong>单价拦截失控调用，不是对账；真实金额以服务商账单为准。
              </span>
            </div>
          </label>
        )}

        {/* 只向查实过写法的厂商显示。其他家摆出来就是个点了没反应的开关。 */}
        {spec?.supportsThinkingOff && (
          <div className={styles.field}>
            <span className={styles.label}>关掉模型思考</span>
            <div className={styles.row}>
              <input
                type="checkbox"
                className={styles.toggleCheck}
                checked={config.thinkingOff}
                onChange={(e) => p.onSave({ thinkingOff: e.target.checked })}
              />
              <span className={styles.hint}>
                更快、更便宜。{spec.name}的新模型
                <strong>默认都会先思考</strong>，而思考的 token 照样计费、也照样占用动作的
                token 上限。剪贴板动作多是短产物，思考在这里几乎是纯成本。需要深度推理（如解释复杂报错）时再打开它。
              </span>
            </div>
          </div>
        )}

        {/* 标签作为意图上下文。文案必须先说“会发出去”再说好处——
            这个开关默认是开的，用户得能从描述里直接看出要不要关。 */}
        <div className={styles.field}>
          <span className={styles.label}>标签作为意图上下文</span>
          <div className={styles.row}>
            <input
              type="checkbox"
              className={styles.toggleCheck}
              checked={config.tagsAsContext}
              onChange={(e) => p.onSave({ tagsAsContext: e.target.checked })}
            />
            <span className={styles.hint}>
              开着时，你给条目打的<strong>手工标签名会随内容一起发给服务商</strong>（自动标签不会）。
              它让模型知道“这条要干什么”——“待回复”、“周报素材”这类信息文本里根本判不出来，
              回复草稿、周报这些动作靠它才推得准。
              如果你的标签里带客户名、项目名或人名，关掉它。
              （标签名与正文同过一道敏感信息检查，带密钥/手机号时照样会先问你。）
            </span>
          </div>
        </div>

        <div className={styles.field}>
          <span className={styles.label}>启用 AI 动作</span>
          <div className={styles.row}>
            <input
              type="checkbox"
              className={styles.toggleCheck}
              checked={config.enabled}
              onChange={(e) => p.onSave({ enabled: e.target.checked })}
            />
            <span className={styles.hint}>
              关闭时变换中心不会出现 AI 分组。测试通过时会自动打开。
            </span>
          </div>
        </div>

        {/* M5-2：AI 记忆增强。开关默认关；出网的只有摘要与搜索词，原文永不出本机。
            组件自己按 useAiStatus 门控（规则 #16），未启用时整行不渲染。 */}
        <AiSemanticField open={p.open} />

        {p.hasKey && (
          <div className={styles.row}>
            {confirmClear ? (
              <>
                <button
                  className={settings.btnDanger}
                  onClick={() => {
                    setConfirmClear(false);
                    p.onClearKey();
                  }}
                >
                  确认删除（不可恢复）
                </button>
                <button className={settings.btnSecondary} onClick={() => setConfirmClear(false)}>
                  取消
                </button>
              </>
            ) : (
              <button className={settings.btnDanger} onClick={() => setConfirmClear(true)}>
                删除这家的密钥
              </button>
            )}
            <span className={styles.hint}>只删 {spec?.name ?? "当前服务商"} 的，其他家不受影响。</span>
          </div>
        )}
      </div>
    </AiSection>
  );
}
