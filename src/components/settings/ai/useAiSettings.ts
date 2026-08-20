/**
 * AI 设置页的**状态与副作用**。
 *
 * 从 AiTab.tsx 抽出来的原因很直白：那个文件到了 465 行，破了项目规则 #7 的
 * 300 行上限。“读写配置 / 切服务商 / 测连接 / 管自定义服务商”和
 * “页面摆哪几个区块”本来就是两件事，拆开后 AiTab 只负责后者。
 *
 * **密钥只写不读**：后端没有返回密钥的接口，所以这里只能给出“已配置 / 未配置”。
 */

import { useCallback, useEffect, useRef, useState } from "react";
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
import { aiQuotaGet, type QuotaInfo } from "@/lib/api/quota";
import {
  type AiConfigChangedPayload,
  emitAiConfigChanged,
  notifyAiConfigWritten,
  refreshAiAvailability,
} from "@/lib/aiAvailability";
import { useToast } from "@/components/Toast";
import { logger } from "@/lib/logger";
import { aiOnboardingSeen, markAiOnboardingSeen } from "@/components/AiOnboarding";
import { FALLBACK_PROVIDER } from "./errorHint";
import type { CustomEditorState } from "./AiCustomProviderDialog";

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
  // 默认开：手工标签是“这条要干什么”的唯一来源，文本里判不出来。
  // 与后端 Default 保持一致（provider.rs），两边不一致会让首次打开设置面板就静默改写配置。
  tagsAsContext: true,
  profileAsContext: true,
};

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 给每个实例一个身份，用来在监听里认出「这是我自己刚写的」，见 sourceRef */
let sourceSeq = 0;

export function useAiSettings() {
  const { toast } = useToast();
  const [config, setConfig] = useState<AiConfig>(DEFAULT_CONFIG);
  const [providers, setProviders] = useState<AiProviderInfo[]>([]);
  const [hasKey, setHasKey] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [usage, setUsage] = useState<AiUsage | null>(null);
  /** 免费额度（内置 Agnes）——方案 B 的摘要卡要把剩余额度摆到顶部 */
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [customEditor, setCustomEditor] = useState<CustomEditorState | null>(null);
  /** reload 失败不静默——错误条 + 重试 */
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 首次配置成功弹 3 步引导（只弹一次） */
  const [showOnboard, setShowOnboard] = useState(false);
  const keyRef = useRef<HTMLInputElement>(null);
  /** persist 串行链（前一次落盘完成后才发下一次，防快速切换竞态） */
  const persistChain = useRef<Promise<void>>(Promise.resolve());
  /** 是否成功读到过真实配置。没读到就一律禁止落盘，见 persist 开头的守卫。 */
  const loadedRef = useRef(false);
  /** 本实例在 ai-config-changed 里的自报身份。惰性初始化：不能写成
   *  useRef(`...${++sourceSeq}`)，那个表达式每次 render 都会算一遍、把计数器推走。 */
  const sourceRef = useRef("");
  if (!sourceRef.current) sourceRef.current = `ai-settings-${++sourceSeq}`;

  const spec = providers.find((it) => it.id === config.provider) ?? null;
  /** 免密钥厂商（Ollama 与内置免费都算）：用于「配没配好」判定，
   *  以及「不按金额计费 → 展示 token 而不是 ¥」的那些分支。 */
  const isLocal = !!spec && !spec.needsKey;
  /** 真·本地：内容确实不出本机。
   *
   *  绝不能拿 isLocal 顶替它：内置免费同样免密钥、同样不按金额计费，但它是**远程**服务，
   *  内容照样出网。之前就是用 isLocal 当隐私判据，于是设置页与用量卡都对着 Agnes 说
   *  「内容不出这台电脑」——而同一个免费额度弹窗的标题写着「内容会发送到该服务商」，
   *  两块界面互相打脸，且错的那句正好是用户最该信得过的一句。
   *  后端 provider.rs is_local() 用的是白名单、也警告过不要从 needsKey 推断，两边保持一致。 */
  const contentStaysLocal = isLocal && !spec?.builtinFree;
  const configured = isLocal || hasKey;

  /** 免费额度单独拉：拉不到不应该让整页报“设置加载失败”，它只是一个展示项。 */
  const reloadQuota = useCallback(async () => {
    try {
      setQuota(await aiQuotaGet());
    } catch {
      setQuota(null);
    }
  }, []);

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
      loadedRef.current = true; // 拿到真配置了，从这一刻起才允许落盘
    } catch (e) {
      setLoadError(err(e));
      logger.warn("加载 AI 设置失败", e);
    }
    void reloadQuota();
  }, [reloadQuota]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 别处改了 AI 配置也要跟上。以前只有上面这一次挂载加载，于是「免费额度」弹窗的
  // 「一键启用内置免费」写完库、广播完事件，这个页面的 config 还是旧的：
  // 「启用 AI 动作」照旧显示关（用户以为"点了没生效"），更糟的是接着动任何一个开关，
  // 都会把这份旧值（enabled:false + 上一家 provider）当成用户配置写回去，把刚启用的又关掉。
  //
  // 自己发的事件必须跳过：persist 是乐观更新（先 setConfig 再落盘），
  // 自写自读会让 reload 跟乐观更新抢——连点开关时前一次的 reload 可能落在后一次写之后，
  // 界面就会闪回旧值。persistChain 只串行化写，管不了这个。
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<AiConfigChangedPayload | null>("ai-config-changed", (e) => {
          if (e.payload?.source === sourceRef.current) return;
          void reload();
        }),
      )
      .then((un) => {
        if (cancelled) un();
        else unlisten = un;
      })
      .catch((e) => logger.warn("监听 ai-config-changed 失败，外部改动不会即时反映", e));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [reload]);

  /** 落盘并让变换中心里的 AI 动作即时出现/消失。
   *  写路径统一在这里广播 ai-config-changed（commit/changeProvider/saveNow 都走它）。
   *  串行化：快速切换服务商/连点开关时，后一次保存等前一次落盘完成，避免竞态。 */
  const persist = useCallback(
    async (next: AiConfig) => {
      // 没成功读到过真实配置就绝不落盘：此时 config 仍是 DEFAULT_CONFIG
      // （enabled:false + provider:deepseek），任何一次开关/失焦都会把这份默认值
      // 当成"用户配置"写进库，把真配置冲掉。这不是假设——已经发生过：
      // 「已启用 + 内置免费」被写成「未启用 + deepseek」，而 deepseek 从没存过密钥，
      // 于是 AI 整体变成"未配置"，用户配好的东西凭空消失。
      // 不可逆的数据损坏比"这次没保存上"严重得多，所以宁可不保存。
      // 规则 15.3：不静默——明确告诉用户为什么没保存，以及怎么恢复。
      if (!loadedRef.current) {
        toast("配置还没读出来，等它加载好或点「重试」再改——现在保存会把默认值写成你的配置", "error");
        void reload(); // 顺手再试一次加载，别让用户卡在这儿
        return;
      }
      setConfig(next);
      try {
        await persistChain.current;
        persistChain.current = (async () => {
          await aiSetConfig(next);
          await notifyAiConfigWritten(sourceRef.current);
        })();
        await persistChain.current;
      } catch (e) {
        toast(`保存 AI 设置失败：${err(e)}`, "error");
        // 乐观更新失败 → reload 回填真实落盘值，界面不显示未保存的假值
        void reload();
      }
    },
    [toast, reload]
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
      // per-provider 存储，切换不再清空落盘——
      // 1) 先把当前家的草稿落盘（2）读新家已保存的 模型/地址/协议 回填，
      // 于是切走切回配置都在。
      setKeyInput("");
      setTestMsg(null);
      try {
        await persist(config);
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
      // 测试结果人性化：去掉 ms 与原始回复（普通用户看不懂、也不关心），
      // 只留“能用 + 模型名”；模型名保留用于对账。
      setTestMsg({
        ok: true,
        text:
          `连接成功，可以开始用了` +
          (r.model ? `（${r.model} 正常响应）` : "") +
          (r.autoEnabled ? " · 已自动启用" : ""),
      });
      if (!aiOnboardingSeen()) {
        markAiOnboardingSeen();
        setShowOnboard(true);
      }
      await emitAiConfigChanged(sourceRef.current);
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
    // 二次确认在 AiAdvanced 里（confirmClear），这里只负责真删
    try {
      await aiClearKey(config.provider);
      setHasKey(false);
      setTestMsg(null);
      await refreshAiAvailability();
      setProviders(await aiListProviders());
      await emitAiConfigChanged(sourceRef.current);
      toast(`已删除 ${spec?.name ?? "当前服务商"} 的密钥`, "success");
    } catch (e) {
      toast(`删除密钥失败：${err(e)}`, "error");
    }
  }, [config.provider, spec, toast]);

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

  return {
    // 状态
    config,
    providers,
    hasKey,
    keyInput,
    usage,
    quota,
    testing,
    testMsg,
    customEditor,
    loadError,
    showOnboard,
    keyRef,
    // 衍生
    spec,
    isLocal,
    contentStaysLocal,
    configured,
    // 动作
    setKeyInput,
    setCustomEditor,
    setShowOnboard,
    reload,
    draft,
    commit,
    saveNow,
    changeProvider,
    saveAndTest,
    clearKey,
    handleCustomSaved,
    handleCustomDeleted,
  };
}
