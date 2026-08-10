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
  aiDeleteCustomProvider,
  aiGetConfig,
  aiGetProviderConfig,
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
import {
  AiCustomProviderDialog,
  type CustomEditorState,
} from "./ai/AiCustomProviderDialog";
import { AiOnboarding, aiOnboardingSeen, markAiOnboardingSeen } from "@/components/AiOnboarding";
import { hintForError, FALLBACK_PROVIDER, type AiErrorAction } from "./ai/errorHint";
import styles from "./AiTab.module.css";

const DEFAULT_CONFIG: AiConfig = {
  enabled: false,
  provider: FALLBACK_PROVIDER,
  baseUrl: "",
  model: "",
  dailyBudgetCny: 3,
  timeoutSecs: 60,
  // 默认关掉思考：剪贴板动作多是短产物，思维链在这里几乎是纯成本
  thinkingOff: true,
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
  // v6.4 自定义服务商编辑器（null = 关闭）
  const [customEditor, setCustomEditor] = useState<CustomEditorState | null>(null);
  // v6.4 审查修复：#4 清空密钥二次确认（密钥不可恢复）
  const [confirmClearKey, setConfirmClearKey] = useState(false);
  // v6.4 审查修复：#5 reload 失败不再静默——错误条 + 重试
  const [loadError, setLoadError] = useState<string | null>(null);
  // v6.4 主窗口 AI 感知（方案 C）：首次配置成功弹引导
  const [showOnboard, setShowOnboard] = useState(false);

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
      setLoadError(null);
    } catch (e) {
      setLoadError(err(e));
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
      // v6.4 AI 面板 v2：per-provider 存储，切换不再清空落盘——
      // 1) 先把当前家的草稿落盘（写进它的 overrides/数组项）；
      // 2) 读新家已保存的 模型/地址/协议 回填；
      // 3) 只切 provider 与值，切走切回配置都在。
      setKeyInput("");
      setTestMsg(null);
      try {
        await persist(config); // 当前家：ai_set_config 按 provider 落位
        const pc = await aiGetProviderConfig(id);
        await persist({
          ...config,
          provider: id,
          baseUrl: pc.baseUrl,
          model: pc.model,
          protocol: pc.protocol ?? "",
        });
      } catch (e) {
        toast(`切换服务商失败：${err(e)}`, "error");
      }
      // 新厂商可能早就存过密钥（密钥按厂商分开存）；用量也要重拉
      try {
        const [keyed, use] = await Promise.all([aiHasKey(id), aiGetUsage()]);
        setHasKey(keyed);
        setUsage(use);
      } catch (e) {
        logger.warn("切换服务商后刷新状态失败", e);
      }
    },
    [config, persist, toast]
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
      // v6.4 方案 C：首次配置成功 → 弹 3 步引导（只弹一次）
      if (!aiOnboardingSeen()) {
        markAiOnboardingSeen();
        setShowOnboard(true);
      }
      // v6.4 审查：#6 通知主窗口 AI 状态即时刷新（快捷区/胶囊不用重启生效）
      try {
        const { emit } = await import("@tauri-apps/api/event");
        await emit("ai-config-changed");
      } catch {
        /* 事件失败不打扰 */
      }
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
      setConfirmClearKey(false);
      setTestMsg(null);
      await refreshAiAvailability();
      setProviders(await aiListProviders());
      toast(`已删除 ${spec?.name ?? "当前服务商"} 的密钥`, "success");
    } catch (e) {
      toast(`删除密钥失败：${err(e)}`, "error");
    }
  }, [config.provider, spec, toast]);

  const hint = testMsg && !testMsg.ok ? hintForError(testMsg.text) : null;

  // ── v6.4 自定义服务商管理 ──
  const handleCustomSaved = useCallback(
    async (id: string, isNew: boolean) => {
      setCustomEditor(null);
      await reload();
      if (isNew) await changeProvider(id); // 新增后直接切过去配置
    },
    [reload, changeProvider]
  );

  const handleCustomDeleted = useCallback(
    async (id: string) => {
      try {
        await aiDeleteCustomProvider(id);
        toast("已删除自定义服务商", "success");
        await reload();
        if (config.provider === id) await changeProvider(FALLBACK_PROVIDER);
      } catch (e) {
        toast(`删除失败：${err(e)}`, "error");
      }
    },
    [reload, changeProvider, config.provider, toast]
  );

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

      {/* v6.4 审查：#5 加载失败错误条 + 重试 */}
      {loadError && (
        <div className={styles.loadError}>
          <span>设置加载失败：{loadError}</span>
          <button className={styles.retryBtn} onClick={() => void reload()}>
            重试
          </button>
        </div>
      )}

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
        onAddCustom={() => setCustomEditor({ mode: "add" })}
        onEditCustom={(item) => setCustomEditor({ mode: "edit", item })}
        onDeleteCustom={(id) => void handleCustomDeleted(id)}
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

      {/* v6.4 自定义服务商弹窗 */}
      {customEditor && (
        <AiCustomProviderDialog
          editor={customEditor}
          onClose={() => setCustomEditor(null)}
          onSaved={(id, isNew) => void handleCustomSaved(id, isNew)}
        />
      )}

      {/* v6.4 方案 C：首次配置成功引导 */}
      <AiOnboarding open={showOnboard} onClose={() => setShowOnboard(false)} />
    </div>
  );
}
