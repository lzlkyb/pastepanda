/**
 * AI 设置面板。负责状态与编排，具体块在 `./ai/` 下。
 *
 * **分层渐进**：主流程只有“选服务商 → 粘密钥 → 保存并测试”两步，
 * 地址/模型/协议/超时/预算全在折叠的高级区。十六家厂商如果把所有旋钮一字排开，
 * 用户第一眼看到的就是一堆不知道该不该动的字段。
 *
 * **密钥只写不读**：后端没有返回密钥的接口，所以这里只能显示“已配置 / 未配置”。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Circle, PauseCircle } from "lucide-react";
import {
  aiClearKey,
  aiGetConfig,
  aiGetUsage,
  aiHasKey,
  aiListProviders,
  aiSetConfig,
  aiSetKey,
  aiTestConnection,
  type AiConfig,
  type AiProviderInfo,
  type AiUsage,
} from "@/lib/api";
import { refreshAiAvailability } from "@/lib/transforms";
import { useToast } from "@/components/Toast";
import { logger } from "@/lib/logger";
import { AiSetupStep } from "./ai/AiSetupStep";
import { AiAdvanced } from "./ai/AiAdvanced";
import { AiUsageCard } from "./ai/AiUsageCard";
import { AiUsageDetail } from "./ai/AiUsageDetail";
import { AiCustomActions } from "./ai/AiCustomActions";
import { hintForError, FALLBACK_PROVIDER, type AiErrorAction } from "./ai/errorHint";
import styles from "./AiTab.module.css";

const DEFAULT_CONFIG: AiConfig = {
  enabled: false,
  provider: FALLBACK_PROVIDER,
  baseUrl: "",
  model: "",
  dailyBudgetCny: 3,
  timeoutSecs: 60,
  protocol: "",
};

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function AiTab() {
  const { toast } = useToast();
  const [config, setConfig] = useState<AiConfig>(DEFAULT_CONFIG);
  const [providers, setProviders] = useState<AiProviderInfo[]>([]);
  const [hasKey, setHasKey] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [usage, setUsage] = useState<AiUsage | null>(null);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const keyRef = useRef<HTMLInputElement>(null);

  const spec = providers.find((it) => it.id === config.provider) ?? null;
  const isLocal = !!spec && !spec.needsKey;
  const configured = isLocal || hasKey;

  const reload = useCallback(async () => {
    try {
      const [cfg, provs, keyed, use] = await Promise.all([
        aiGetConfig(),
        aiListProviders(),
        aiHasKey(),
        aiGetUsage(),
      ]);
      setConfig(cfg);
      setProviders(provs);
      setHasKey(keyed);
      setUsage(use);
    } catch (e) {
      logger.warn("加载 AI 设置失败", e);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 落盘并让变换中心里的 AI 动作即时出现/消失 */
  const persist = useCallback(
    async (next: AiConfig) => {
      setConfig(next);
      try {
        await aiSetConfig(next);
        await refreshAiAvailability();
      } catch (e) {
        toast(`保存 AI 设置失败：${err(e)}`, "error");
      }
    },
    [toast]
  );

  const draft = useCallback((patch: Partial<AiConfig>) => {
    setConfig((prev) => ({ ...prev, ...patch }));
  }, []);

  const commit = useCallback(() => {
    void persist(config);
  }, [config, persist]);

  const saveNow = useCallback(
    (patch: Partial<AiConfig>) => {
      void persist({ ...config, ...patch });
    },
    [config, persist]
  );

  const changeProvider = useCallback(
    async (id: string) => {
      // 换厂商必须清掉地址/模型/协议的覆盖值，否则会拿上一家的值去请求新家
      setKeyInput("");
      setTestMsg(null);
      await persist({ ...config, provider: id, baseUrl: "", model: "", protocol: "" });
      // 新厂商可能早就存过密钥（密钥按厂商分开存）；用量也要重拉，它带着预算与次数估算
      try {
        const [keyed, use] = await Promise.all([aiHasKey(id), aiGetUsage()]);
        setHasKey(keyed);
        setUsage(use);
      } catch (e) {
        logger.warn("切换服务商后刷新状态失败", e);
      }
    },
    [config, persist]
  );

  const saveAndTest = useCallback(async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      const key = keyInput.trim();
      if (key) {
        await aiSetKey(key, config.provider);
        setKeyInput("");
      }
      // 配置必须先落盘：ai_test_connection 读的是库里的配置，不是界面上的草稿
      await aiSetConfig(config);
      const r = await aiTestConnection();
      setTestMsg({
        ok: true,
        text:
          `已就绪 · ${r.model} · ${r.latencyMs}ms · 回复“${r.reply}”` +
          (r.autoEnabled ? " · 已自动启用" : ""),
      });
      await reload();
      await refreshAiAvailability();
    } catch (e) {
      setTestMsg({ ok: false, text: err(e) });
      // 失败也可能是“密钥存了但不对”，状态得跟上
      try {
        setHasKey(await aiHasKey(config.provider));
        setProviders(await aiListProviders());
      } catch {
        /* 读不到就维持原样，不再叠一层错误提示 */
      }
    } finally {
      setTesting(false);
    }
  }, [config, keyInput, reload]);

  const clearKey = useCallback(async () => {
    try {
      await aiClearKey(config.provider);
      setHasKey(false);
      setTestMsg(null);
      await refreshAiAvailability();
      setProviders(await aiListProviders());
      toast(`已删除 ${spec?.name ?? "当前服务商"} 的密钥`, "success");
    } catch (e) {
      toast(`删除密钥失败：${err(e)}`, "error");
    }
  }, [config.provider, spec, toast]);

  const hint = testMsg && !testMsg.ok ? hintForError(testMsg.text) : null;

  const runHintAction = (action: AiErrorAction) => {
    if (action === "focusKey") keyRef.current?.focus();
    else if (action === "openAdvanced") setAdvancedOpen(true);
    else if (action === "switchProvider") void changeProvider(FALLBACK_PROVIDER);
  };

  return (
    <div className={styles.panel}>
      <div className={styles.statusBar}>
        {!configured ? (
          <span className={`${styles.badge} ${styles.badgeIdle}`}>
            <Circle size={11} /> 未配置
          </span>
        ) : config.enabled ? (
          <span className={`${styles.badge} ${styles.badgeReady}`}>
            <CheckCircle2 size={11} /> 已就绪
          </span>
        ) : (
          <span className={`${styles.badge} ${styles.badgeOff}`}>
            <PauseCircle size={11} /> 已停用
          </span>
        )}
        <span className={styles.statusText}>
          {!configured
            ? "配好一家服务商，变换中心就会多出翻译 / 摘要 / 解释代码 / 改写四个动作。"
            : config.enabled
              ? `当前使用 ${spec?.name ?? config.provider}。`
              : "已配置但未启用，变换中心里看不到 AI 分组。"}
        </span>
      </div>

      {/* 这一栏不能去掉：用户有权在开启前知道剪贴板内容会离开本机 */}
      <div className={styles.warn}>
        <AlertTriangle size={14} className={styles.warnIcon} />
        <span>
          你主动对某条内容执行 AI 动作时，该条内容会被发送到所选服务商。
          PastePanda 不会自动上传任何历史记录。看起来像密钥/凭证的内容会先拦下来请你确认。
          {isLocal && "（当前选的是本地模型，内容不出这台电脑。）"}
        </span>
      </div>

      <AiSetupStep
        providers={providers}
        spec={spec}
        config={config}
        keyInput={keyInput}
        hasKey={hasKey}
        testing={testing}
        keyRef={keyRef}
        onProviderChange={(id) => void changeProvider(id)}
        onKeyInput={setKeyInput}
        onDraft={draft}
        onCommit={commit}
        onSave={saveNow}
        onSaveAndTest={() => void saveAndTest()}
      />

      {testMsg && (
        <div className={`${styles.testResult} ${testMsg.ok ? styles.testOk : styles.testFail}`}>
          <div>{testMsg.text}</div>
          {hint && (
            <div className={styles.testHint}>
              <span>{hint.hint}</span>
              {hint.action && (
                <button className={styles.linkBtn} onClick={() => runHintAction(hint.action)}>
                  {hint.actionLabel}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <AiUsageCard usage={usage} isLocal={isLocal} />

      {/* 没有可用模型时不显示：在那儿写模板是空转。
          用量明细不跟着藏——那是已经花掉的钱的记录，关个开关就看不到自己的账说不过去。 */}
      {configured && config.enabled && <AiCustomActions />}

      <AiUsageDetail />

      <AiAdvanced
        open={advancedOpen}
        onToggle={() => setAdvancedOpen((v) => !v)}
        config={config}
        spec={spec}
        hasKey={hasKey}
        onDraft={draft}
        onCommit={commit}
        onSave={saveNow}
        onClearKey={() => void clearKey()}
      />
    </div>
  );
}
