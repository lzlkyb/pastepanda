/**
 * 高级设置（默认折叠）。
 *
 * 放进来的标准：**不填也能跑起来的东西**。服务商、模型、密钥都在主流程
 * （见 AiSetupStep）——模型也包括手填，所以这里不再重复一份。
 */

import { ChevronDown, ChevronRight, Database, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { AiConfig, AiProviderInfo } from "@/lib/api";
import {
  semanticStatus,
  semanticIndex,
  semanticSetConfig,
  type SemanticStatus,
} from "@/lib/api/semantic";
import { useToast } from "@/components/Toast";
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
  // M5-2 语义索引状态
  const [sem, setSem] = useState<SemanticStatus | null>(null);
  const [modelDraft, setModelDraft] = useState("");
  const [indexing, setIndexing] = useState(false);
  const { toast } = useToast();

  const loadSem = useCallback(async () => {
    try {
      const s = await semanticStatus();
      setSem(s);
      setModelDraft(s.model);
    } catch {
      setSem(null);
    }
  }, []);

  useEffect(() => {
    if (p.open) void loadSem();
  }, [p.open, loadSem]);

  const toggleSem = useCallback(
    async (enabled: boolean) => {
      try {
        await semanticSetConfig(enabled, null);
        toast(enabled ? "已开启 AI 记忆增强" : "已关闭，搜索退回关键词匹配", "success");
        void loadSem();
      } catch (e) {
        toast(`设置失败：${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
    [loadSem, toast],
  );

  const saveModel = useCallback(
    async () => {
      try {
        await semanticSetConfig(sem?.enabled ?? false, modelDraft);
        toast("embedding 模型已保存", "success");
        void loadSem();
      } catch (e) {
        toast(`保存失败：${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
    [loadSem, modelDraft, sem?.enabled, toast],
  );

  const runIndex = useCallback(async () => {
    setIndexing(true);
    try {
      const r = await semanticIndex();
      toast(
        r.indexed > 0
          ? `已索引 ${r.indexed} 条${r.pendingLeft > 0 ? `，还有 ${r.pendingLeft} 条待处理` : ""}`
          : "没有需要索引的条目",
        "success",
      );
      void loadSem();
    } catch (e) {
      toast(`索引失败：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setIndexing(false);
    }
  }, [loadSem, toast]);

  return (
    <div className={styles.advanced}>
      <button className={styles.advancedToggle} onClick={p.onToggle}>
        {p.open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        高级设置
        <span className={styles.advancedHint}>接口地址、协议、超时、思考、费用上限</span>
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

          {/* M5-2：AI 记忆增强（语义搜索）。开关默认关，出网的只有摘要与搜索词，原文永不出本机 */}
          <div className={styles.field}>
            <span className={styles.label}>AI 记忆增强（语义搜索）</span>
            <div className={styles.row}>
              <input
                type="checkbox"
                className={styles.toggleCheck}
                checked={sem?.enabled ?? false}
                disabled={!sem}
                onChange={(e) => void toggleSem(e.target.checked)}
              />
              <span className={styles.hint}>
                开启后，历史摘要会生成语义向量存在本地：搜"上周那个 API 文档"这类凭印象的查询
                能按<strong>意思</strong>命中，而不是只按字面。摘要/搜索词会发给当前 AI 厂商计费
                （受日预算约束），<strong>原文永不出本机</strong>；关闭即退回关键词搜索，可随时清除。
              </span>
            </div>

            {sem?.enabled && (
              <div className={styles.row} style={{ marginTop: 6, flexWrap: "wrap", gap: 8 }}>
                <input
                  className={styles.input}
                  style={{ width: 200, padding: "5px 9px", fontSize: 11.5 }}
                  value={modelDraft}
                  placeholder={sem.defaultModel || "embedding 模型名"}
                  onChange={(e) => setModelDraft(e.target.value)}
                  onBlur={() => void saveModel()}
                />
                <button
                  className={settings.btnSecondary}
                  onClick={() => void runIndex()}
                  disabled={indexing}
                  style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
                >
                  {indexing ? <Loader2 size={12} className="spin" /> : <Database size={12} />}
                  {indexing ? "索引中…" : "立即建立索引"}
                </button>
                <span className={styles.hint}>
                  已索引 <b>{sem.vectorCount}</b> 条
                  {sem.pending > 0 ? `，${sem.pending} 条待处理（搜索时会自动补）` : ""}
                  {sem.providerSupports
                    ? ` · 厂商 ${sem.provider} · 模型 ${sem.model || sem.defaultModel || "待填"}`
                    : ` · ⚠️ 厂商 ${sem.provider} 不支持 embedding，请换 OpenAI 兼容厂商或在上面填中转模型`}
                </span>
              </div>
            )}
          </div>

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
      )}
    </div>
  );
}
