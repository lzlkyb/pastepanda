/**
 * AI 设置面板。**只负责编排**：一张摘要卡 + 四个互斥手风琴区块。
 *
 * 状态与副作用在 useAiSettings；服务商网格在 AiProviderGrid；
 * 折叠外壳在 AiSection。这么拆是因为改版前这个文件 465 行，
 * 破了项目规则 #7 的 300 行上限。
 *
 * **为什么是手风琴而不是一列卡片堆叠**（方案 B）：
 * 改版前一页有 7 个区块、**4 套互不相同的卡片外壳**（有框卡 `.cfgCard` /
 * 无框底色卡 `.usageCard` / 只有一条上边框 `.advanced` ×3 / QuotaEntryCard 自己一套）、
 * 2 种折叠范式，而“现在能不能用 / 花了多少 / 还剩多少”三个数字分散在 4 个块里。
 * 现在：摘要卡一屏答完那三个问题，其余全部收进同一种外壳的手风琴，
 * 同时只展开一个 → 页面高度基本恒定。
 *
 * 四个区块里两个由这里包 AiSection、两个（自定义动作 / 高级）自己包——
 * 因为它们的副标题要用自己内部的数据（如“已有 3 个”），提到父级得多传一层。
 */

import { useEffect, useState } from "react";
import { AlertTriangle, Clock3, Server } from "lucide-react";
import { useDialogStore } from "@/stores/dialogStore";
import { AiSetupStep } from "./ai/AiSetupStep";
import { AiAdvanced } from "./ai/AiAdvanced";
import { AiUsageCard } from "./ai/AiUsageCard";
import { AiUsageDetail } from "./ai/AiUsageDetail";
import { AiCustomActions } from "./ai/AiCustomActions";
import { AiCustomProviderDialog } from "./ai/AiCustomProviderDialog";
import { AiHeroCard } from "./ai/AiHeroCard";
import { AiEvolution } from "./ai/AiEvolution";
import { AiSection } from "./ai/AiSection";
import { useAiSettings } from "./ai/useAiSettings";
import { AiOnboarding } from "@/components/AiOnboarding";
import { hintForError, FALLBACK_PROVIDER, type AiErrorAction } from "./ai/errorHint";
import styles from "./AiTab.module.css";

type SectionKey = "setup" | "usage" | "evolution" | "actions" | "advanced";

export function AiTab() {
  const s = useAiSettings();
  const [openKey, setOpenKey] = useState<SectionKey | null>(null);

  // 未配置 → 自动展开「服务商与密钥」（新用户进来第一件事就是配）；
  // 配好后自动收起，不长期占住主视区。
  //
  // 必须等 providers 拉回来再判：初始态下 hasKey 还是 false，configured 也就是 false，
  // 不拦的话已配置的用户每次打开设置都会看到这个区块闪开一下又收起。
  useEffect(() => {
    if (!s.providers.length) return;
    setOpenKey(s.configured ? null : "setup");
  }, [s.providers.length, s.configured]);

  /** 互斥：点开一个自动收起其他；点已展开的那个则收起 */
  const toggle = (k: SectionKey) => setOpenKey((prev) => (prev === k ? null : k));

  const hint = s.testMsg && !s.testMsg.ok ? hintForError(s.testMsg.text) : null;

  const runHintAction = (action: AiErrorAction) => {
    if (action === "focusKey") {
      setOpenKey("setup");
      // 密钥输入框只在区块展开后才挂载，所以不能立即 focus。
      // setTimeout 0 会排到下一个宏任务，那时 React 已经提交完这次渲染。
      setTimeout(() => s.keyRef.current?.focus(), 0);
    } else if (action === "openAdvanced") {
      setOpenKey("advanced");
    } else if (action === "switchProvider") {
      void s.changeProvider(FALLBACK_PROVIDER);
    }
  };

  const setupSub = s.configured
    ? `${s.spec?.name ?? s.config.provider} · ${s.config.model || s.spec?.models?.[0]?.id || "…"}`
    : "选厂商 · 粘密钥 · 测连接";

  const usageSub = !s.usage
    ? "每次调用的 token 与花费，不含内容"
    : s.isLocal
      ? `今日 ${s.usage.calls} 次 · token ${s.usage.promptTokens + s.usage.completionTokens}`
      : `今日 ${s.usage.calls} 次 · ¥${s.usage.costCny.toFixed(2)}`;

  return (
    <div className={styles.panel}>
      {/* 加载失败错误条 + 重试。不静默：读不到配置而页面看起来正常是最坑的。 */}
      {s.loadError && (
        <div className={styles.loadError}>
          <span>设置加载失败：{s.loadError}</span>
          <button className={styles.retryBtn} onClick={() => void s.reload()}>
            重试
          </button>
        </div>
      )}

      <AiHeroCard
        spec={s.spec}
        config={s.config}
        configured={s.configured}
        isLocal={s.isLocal}
        usage={s.usage}
        quota={s.quota}
        testing={s.testing}
        onTest={() => void s.saveAndTest()}
        onOpenSetup={() => setOpenKey("setup")}
        onOpenQuota={() => useDialogStore.getState().openQuota()}
      />

      {/*
       * 测试结果必须摆在**摘要卡旁边的顶层**，不能放进「服务商与密钥」区块。
       * 刚改完时它在那个区块里，而已配置的用户 openKey 是 null、区块是收起的，
       * AiSection 收起时不渲染 children——于是点摘要卡上的「测试连接」没任何反馈，
       * 失败也静默。规则：触发按钮常驻可见，它的结果就必须同样常驻可见。
       * （步骤 3 里的「保存并测试」也走同一个 testMsg，摆在顶层两边都照顾到。）
       */}
      {s.testMsg && (
        <div className={`${styles.testResult} ${s.testMsg.ok ? styles.testOk : styles.testFail}`}>
          <div>{s.testMsg.text}</div>
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

      <div className={styles.acc}>
        <AiSection
          icon={<Server size={13} />}
          title="服务商与密钥"
          subtitle={setupSub}
          open={openKey === "setup"}
          onToggle={() => toggle("setup")}
        >
          {/* 这一条不能去掉：用户有权在开启前知道剪贴板内容会离开本机。 */}
          <div className={styles.warn}>
            <AlertTriangle size={14} className={styles.warnIcon} />
            <span>
              你主动对某条内容执行 AI 动作时，该条内容会被发送到所选服务商。
              PastePanda 不会自动上传任何历史记录。看起来像密钥/凭证的内容会先拦下来请你确认。
              {s.isLocal && "（当前选的是本地模型，内容不出这台电脑。）"}
            </span>
          </div>

          <AiSetupStep
            providers={s.providers}
            spec={s.spec}
            config={s.config}
            keyInput={s.keyInput}
            hasKey={s.hasKey}
            testing={s.testing}
            keyRef={s.keyRef}
            onProviderChange={(id) => void s.changeProvider(id)}
            onKeyInput={s.setKeyInput}
            onDraft={s.draft}
            onCommit={s.commit}
            onSave={s.saveNow}
            onSaveAndTest={() => void s.saveAndTest()}
            onAddCustom={() => s.setCustomEditor({ mode: "add" })}
            onEditCustom={(item) => s.setCustomEditor({ mode: "edit", item })}
            onDeleteCustom={(id) => void s.handleCustomDeleted(id)}
          />
        </AiSection>

        <AiSection
          icon={<Clock3 size={13} />}
          title="用量"
          subtitle={usageSub}
          open={openKey === "usage"}
          onToggle={() => toggle("usage")}
        >
          <AiUsageCard usage={s.usage} isLocal={s.isLocal} />
          {/* AiSection 折叠时不渲染 children，所以“展开”就是“挂载”：
              它自己在 mount 时拉数据，不需要再传 open。
              好处仍在：没展开过就一次库都不查。 */}
          <AiUsageDetail />
        </AiSection>

        {/* 自进化（原在「设置 › 通用」的一行🧠，08-11 搬到这里）。
            不跟着 configured 藏：它记的是你已经产生的使用痕迹，
            红线②要求任何时候都可见可删，不能因为没配 AI 就看不到。 */}
        <AiEvolution
          open={openKey === "evolution"}
          onToggle={() => toggle("evolution")}
          profileAsContext={s.config.profileAsContext}
          onProfileAsContextChange={(v) => s.saveNow({ profileAsContext: v })}
        />

        {/* 没有可用模型时不显示：在那儿写模板是空转。
            用量区不跟着藏——那是已经花掉的钱的记录，关个开关就看不到自己的账说不过去。 */}
        {s.configured && s.config.enabled && (
          <AiCustomActions open={openKey === "actions"} onToggle={() => toggle("actions")} />
        )}

        <AiAdvanced
          open={openKey === "advanced"}
          onToggle={() => toggle("advanced")}
          config={s.config}
          spec={s.spec}
          hasKey={s.hasKey}
          onDraft={s.draft}
          onCommit={s.commit}
          onSave={s.saveNow}
          onClearKey={() => void s.clearKey()}
        />
      </div>

      {s.customEditor && (
        <AiCustomProviderDialog
          editor={s.customEditor}
          onClose={() => s.setCustomEditor(null)}
          onSaved={(id, isNew) => void s.handleCustomSaved(id, isNew)}
        />
      )}

      {/* 首次配置成功引导 */}
      <AiOnboarding open={s.showOnboard} onClose={() => s.setShowOnboard(false)} />
    </div>
  );
}
