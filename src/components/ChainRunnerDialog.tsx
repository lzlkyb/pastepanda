/**
 * ChainRunnerDialog.tsx — 动作链运行器（X1 B1）。
 *
 * 把多步粘贴流程串成"一个按钮"：选链 → 运行 → 每步独立预览（前后对比）→ 粘贴最终结果。
 * B1 只跑官方预置链（全部本地变换），编辑器 / 持久化 / AI 步骤留 B2。
 *
 * 交互与红线：
 * - 失败定位到步骤（"步骤 N 失败：原因"），保留到失败前的中间产物，不静默粘半成品；
 * - 每步标 risk，destructive（如脱敏）用危险色提示；
 * - 运行是用户手动触发，链本身永不自动执行（红线①）。
 *
 * 挂载方式仿 TransformHubDialog：常挂载 + AnimatePresence 门控退场。
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X, Play, RotateCcw, Copy, Check, ClipboardPaste, Loader2,
  ShieldAlert, CheckCircle2, Plus, Pencil, Layers, ShieldCheck,
} from "lucide-react";
import { useDialogStore } from "@/stores/dialogStore";
import { PRESET_CHAINS, getChainAsync, loadUserChains, runChain } from "@/lib/chains/registry";
import type { Chain, ChainRunResult, ChainRunStage } from "@/lib/chains/types";
import { pasteTextGuarded } from "@/lib/api";
import { getSession, mergeSessionTexts } from "@/lib/sessionContext";
import { useToast } from "@/components/Toast";
import { useDialogAnim } from "@/lib/dialogMotion";
import { FocusTrap } from "@/components/FocusTrap";
import { SequenceDiscover } from "@/components/SequenceDiscover";
import { AiBadge } from "@/components/AiBadge";
import styles from "./ChainRunnerDialog.module.css";
import { useDialogEscape } from "@/hooks/useDialogEscape";

export function ChainRunnerDialog() {
  const text = useDialogStore((s) => s.chainText);
  /** AI 临时编的链（B）：不在注册表里，只在本次会话有效 */
  const adHoc = useDialogStore((s) => s.chainAdHoc);
  const close = useCallback(() => useDialogStore.getState().closeChain(), []);
  const open = text !== null;

  // Esc 关闭（从枢纽打开时全局 Esc 被 hubItem 让位拦截，必须组件自己处理）。
  // 公共 hook：捕获期 + stopPropagation。
  useDialogEscape(close, open);
  const anim = useDialogAnim();
  const { toast } = useToast();

  const [chainId, setChainId] = useState(PRESET_CHAINS[0].id);
  const [allChains, setAllChains] = useState<Chain[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ChainRunResult | null>(null);
  // 默认全部展开：X1 要求"每步单独预览"，运行完就该看到每步的前后对比
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [copied, setCopied] = useState(false);
  // B2：AI 步骤的运行前确认（云端内容不自动发送）
  const [pendingAi, setPendingAi] = useState<{ index: number; label: string; resolve: (v: boolean) => void } | null>(null);

  // 打开时重置：输入 = 打开时的文本，清掉上一次的结果，并加载自定义链
  useEffect(() => {
    if (open) {
      const hint = useDialogStore.getState().chainIdHint;
      setInput(text ?? "");
      setResult(null);
      setRunning(false);
      setExpanded(new Set());
      setCopied(false);
      const ad = useDialogStore.getState().chainAdHoc;
      void loadUserChains(true).then((user) => {
        // AI 编的临时链排最前：它是用户刚才主动要的那一条
        const all = [...(ad ? [ad] : []), ...user, ...PRESET_CHAINS];
        setAllChains(all);
        // 预选优先级：AI 临时链 > M4 建议的 hint > 保留当前 > 第一条
        setChainId((cur) => {
          if (ad) return ad.id;
          const ids = new Set(all.map((c) => c.id));
          if (hint && ids.has(hint)) return hint;
          return ids.has(cur) ? cur : PRESET_CHAINS[0].id;
        });
      });
    }
    // 审查：对话框关闭（含 unmount）时，若正卡在 AI 确认，立即 resolve(false) 中止，
    // 否则 runChain 里的 Promise 永久挂起（状态+内存泄漏）
    return () => {
      setPendingAi((cur) => {
        if (cur) {
          cur.resolve(false);
          return null;
        }
        return cur;
      });
    };
     
  }, [open, text]);

  const chain = useMemo(
    () => allChains.find((c) => c.id === chainId) ?? PRESET_CHAINS[0],
    [allChains, chainId],
  );
  const originText = text ?? "";

  // v6.5 记忆×链打通：当前工作记忆会话（可一键填入输入，把连续复制的内容喂给链）
  const session = getSession();
  const sessionText =
    session && session.texts.length > 1 ? mergeSessionTexts(session) : null;
  const sessionCount = session?.texts.length ?? 0;

  const run = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setResult(null);
    try {
      // AI 临时链不在注册表里，不能走 getChainAsync（那会报“链已不存在”）
      const target =
        adHoc && chainId === adHoc.id ? adHoc : await getChainAsync(chainId);
      if (!target) {
        toast("这条链已不存在", "error");
        return;
      }
      const r = await runChain(target, input, {}, async (step, index) => {
        return await new Promise<boolean>((resolve) => {
          setPendingAi({ index, label: step.label, resolve });
        });
      });
      setResult(r);
      setExpanded(new Set(r.stages.map((_, i) => i)));
      if (r.ok) toast(`「${target.name}」完成`, "success");
      // v6.5 闭环：链的执行记入行为日志（程序性记忆的数据源）——
      // 链 id 记 action_id，content_type 用 "chain" 标记，不参与动作推荐权重
      try {
        const { logActionEvent } = await import("@/lib/api/actionEvents");
        logActionEvent({
          actionId: target.id,
          contentType: "chain",
          sourceApp: "",
          hour: new Date().getHours(),
          outcome: r.ok ? "copied" : "abandoned",
        });
      } catch {
        // 日志失败不影响主流程
      }
    } catch (e) {
      // 审查：补 catch —— 此前 try/finally 无 catch，异常时浮空 rejection、
      // pendingAi 的确认 promise 可能永不 resolve（配合关窗兜底）
      toast(`执行失败：${e instanceof Error ? e.message : String(e)}`, "error");
      setResult({
        ok: false,
        final: "",
        stages: [],
      });
    } finally {
      setRunning(false);
    }
  }, [adHoc, chainId, input, running, toast]);

  const copy = useCallback(async () => {
    const out = result?.final ?? "";
    if (!out) return;
    try {
      await navigator.clipboard.writeText(out);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast("已复制", "success");
    } catch {
      toast("复制失败", "error");
    }
  }, [result, toast]);

  const paste = useCallback(async () => {
    const out = result?.final ?? "";
    if (!out) return;
    const ok = await pasteTextGuarded(out);
    if (ok) toast("已粘贴到前台", "success");
  }, [result, toast]);

  const toggleStep = (i: number) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const isPreset = (id: string) => PRESET_CHAINS.some((p) => p.id === id);
  const editChain = (c: Chain) =>
    useDialogStore.getState().openChainEditor({
      // AI 临时链的 id 不存在于 chain_defs 表。原样传过去会变成“更新一条不存在的链”，
      // 置空才是用户想要的「存为我的链」（新建）。
      id: adHoc && c.id === adHoc.id ? "" : c.id,
      name: c.name,
      description: c.description,
      steps: c.steps,
    });

  return (
    <AnimatePresence>
      {open && (
        <motion.div {...anim.backdrop} className="dialog-backdrop" onClick={close}>
          <FocusTrap>
            <motion.div
              {...anim.panel}
              className={`dialog-box w460 ${styles.wrap}`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="dialog-header">
                <span className={styles.headerIcon}><Play size={15} /></span>
                <h2 className="dialog-title">动作链</h2>
                <span className={styles.headerSub}>把多步粘贴流程串成一个按钮</span>
                <button onClick={close} className="dialog-close" aria-label="关闭">
                  <X size={16} />
                </button>
              </div>

              {/* 上区：链选择 + 输入 + 运行，钉住不滚。
                  这三样是「选一条 → 跑 → 看 → 换一条再跑」循环的入口，
                  被结果顶走的话每次重跑都要先滚回顶部。 */}
              <div className={styles.fixedTop}>
              {/* V3-B 程序性记忆：高频操作 → 一键存成链 */}
              <SequenceDiscover open={open} />

              {/* 链选择：横向滚动胶囊 tab（v6.10 升级：原竖排大按钮占高、链多要滚） */}
              <div className={styles.chainRow}>
                <div className={styles.chainTabs}>
                  {allChains.map((c) => (
                    <button
                      key={c.id}
                      className={`${styles.chainTab} ${c.id === chainId ? styles.chainTabOn : ""}`}
                      onClick={() => { setChainId(c.id); setResult(null); }}
                      title={c.description || c.name}
                    >
                      <span className={styles.chainTabName}>{c.name}</span>
                      {/* AI 临时链标上 AI：它与用户亲手配的链混在同一列表里，
                          不标就分不清“这条是模型刚编的、没存过” */}
                      {adHoc && c.id === adHoc.id && <AiBadge kind="ai" size="xs" />}
                      {!isPreset(c.id) && (
                        <span
                          className={styles.chainTabEdit}
                          title={
                            adHoc && c.id === adHoc.id ? "存为我的链" : "编辑这条链"
                          }
                          onClick={(e) => {
                            e.stopPropagation();
                            editChain(c);
                          }}
                        >
                          <Pencil size={10} />
                        </span>
                      )}
                    </button>
                  ))}
                </div>
                <button
                  className={styles.newBtn}
                  onClick={() => useDialogStore.getState().openChainEditor(null)}
                >
                  <Plus size={13} /> 新建
                </button>
              </div>

              {/* 当前输入（v6.10 升级：卡片化） */}
              <div className={styles.inputCard}>
                <div className={styles.inputCardHead}>
                  <span>输入 <span className={styles.count}>（{input.length} 字）</span></span>
                  <span className={styles.inputActs}>
                    {input !== originText && (
                      <button className={styles.miniBtn} onClick={() => setInput(originText)}>
                        <RotateCcw size={11} /> 撤销到原始
                      </button>
                    )}
                    {sessionText && input !== sessionText && (
                      <button
                        className={`${styles.miniBtn} ${styles.sessionBtn}`}
                        onClick={() => setInput(sessionText)}
                        title="把工作记忆里的会话内容填进来（v6.5 记忆×链打通）"
                      >
                        <Layers size={11} /> 填入会话（{sessionCount} 条）
                      </button>
                    )}
                  </span>
                </div>
                <pre className={`${styles.inputBody} ${input ? "" : styles.inputEmpty}`}>
                  {input || "（空）"}
                </pre>
              </div>

              {/* 运行（v6.10：步骤摘要改 chip） */}
              <div className={styles.runRow}>
                <button
                  className={styles.runBtn}
                  onClick={() => void run()}
                  disabled={running || !input}
                >
                  {running ? <Loader2 size={13} className="spin" /> : <Play size={13} />}
                  {running ? "运行中…" : "运行整条链"}
                </button>
                <span className={`${styles.stepMetaChip} ${chain.steps.some((s) => s.risk === "network") ? styles.stepMetaAi : ""}`}>
                  {chain.steps.length} 步{chain.steps.some((s) => s.risk === "network") ? " · 含 AI 步骤" : ""}
                </span>
              </div>
              </div>

              {/* 下区：步骤与结果，自己滚。
                  跑完后步骤默认全展开（下方 setExpanded），四步链就 800px，
                  没这层滚动容器的话最终结果与复制/粘贴会掉到屏幕外。 */}
              <div className={styles.scrollBody}>

              {/* B2：AI 步骤的运行前确认（红线：云端内容不自动发送） */}
              {pendingAi && (
                <div className={styles.aiConfirm}>
                  <ShieldAlert size={13} />
                  <span>
                    步骤 {pendingAi.index + 1}「{pendingAi.label}」会把内容发送到云端（可能计费）。继续？
                  </span>
                  <button
                    className={styles.aiGo}
                    onClick={() => { pendingAi.resolve(true); setPendingAi(null); }}
                  >
                    继续
                  </button>
                  <button
                    className={styles.aiNo}
                    onClick={() => { pendingAi.resolve(false); setPendingAi(null); }}
                  >
                    取消
                  </button>
                </div>
              )}

              {/* 步骤流（v6.10：卡片间加连接线） */}
              {result && (
                <div className={styles.steps}>
                  {result.stages.map((s, i) => (
                    <Fragment key={i}>
                      <StepCard
                        stage={s}
                        index={i}
                        expanded={expanded.has(i)}
                        onToggle={() => toggleStep(i)}
                      />
                      {i < result.stages.length - 1 && <div className={styles.stepArrow} />}
                    </Fragment>
                  ))}
                </div>
              )}

              {/* 失败提示 */}
              {result && !result.ok && result.failedAt !== undefined && (
                <div className={styles.failBox}>
                  <ShieldAlert size={13} />
                  步骤 {result.failedAt + 1}/{result.stages.length} 失败：
                  {result.stages[result.failedAt]?.error ?? "未知错误"}
                  <span className={styles.failHint}>已保留失败前的中间结果，可复制</span>
                </div>
              )}

              {/* 最终结果（v6.10：成功绿 / 失败红 色彩化） */}
              {result && (
                <div className={`${styles.finalCard} ${result.ok ? styles.finalOk : styles.finalFail}`}>
                  <div className={styles.finalHead}>
                    {result.ok ? <CheckCircle2 size={13} /> : <ShieldAlert size={13} />}
                    {result.ok ? "最终结果" : "中间结果（保留到失败前）"}
                  </div>
                  <pre className={styles.finalBody}>{result.final}</pre>
                  {/* v6.6 结果反馈：检测到脱敏内容 → 明确告知可放心粘贴 */}
                  {result.ok && result.final.includes("***") && (
                    <div className={styles.maskedRow}>
                      <ShieldCheck size={12} /> 结果已脱敏，可放心粘贴
                    </div>
                  )}
                  <div className={styles.finalActions}>
                    <button
                      className={`${styles.actBtn} ${copied ? styles.copyDone : ""}`}
                      onClick={() => void copy()}
                      disabled={!result.final}
                    >
                      {copied ? <Check size={13} /> : <Copy size={13} />}
                      {copied ? "已复制" : "复制"}
                    </button>
                    <button className={`${styles.actBtn} ${styles.pasteBtn}`} onClick={() => void paste()} disabled={!result.final}>
                      <ClipboardPaste size={13} /> 粘贴到前台
                    </button>
                  </div>
                </div>
              )}

              {!result && !running && (
                <div className={styles.idleHint}>
                  点「运行整条链」开始——每步结果都会展示出来，失败会明确到第几步。
                </div>
              )}
              </div>
            </motion.div>
          </FocusTrap>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** 单步卡片：头部（序号/名称/风险/状态）+ 可展开的前后对比 */
function StepCard({
  stage, index, expanded, onToggle,
}: {
  stage: ChainRunStage;
  index: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const riskClass =
    stage.risk === "destructive" ? styles.riskDanger
    : stage.risk === "network" ? styles.riskNet
    : styles.riskLocal;
  const riskLabel =
    stage.risk === "destructive" ? "修改"
    : stage.risk === "network" ? "联网"
    : "本地";
  return (
    <div className={`${styles.step} ${stage.ok ? styles.stepOk : styles.stepFail}`}>
      <div className={styles.stepHead} onClick={onToggle} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}>
        <span className={styles.stepIdx}>{index + 1}</span>
        <span className={styles.stepName}>{stage.label}</span>
        <span className={`${styles.riskChip} ${riskClass}`}>{riskLabel}</span>
        <span className={styles.stepStatus}>
          {stage.skipped ? (
            <span className={styles.skippedText}>跳过（条件不满足）</span>
          ) : stage.ok ? (
            <><CheckCircle2 size={13} className={styles.stepOkIcon} /><span className={styles.okText}>完成</span></>
          ) : (
            <><ShieldAlert size={13} className={styles.stepFailIcon} /><span className={styles.failText}>失败</span></>
          )}
        </span>
      </div>
      {expanded && (
        <div className={styles.stepDetail}>
          <div className={styles.ioRow}>
            <span className={styles.ioLabel}>输入</span>
            <pre className={styles.ioBox}>{stage.input || "（空）"}</pre>
          </div>
          <div className={styles.ioArrow}>▼</div>
          <div className={styles.ioRow}>
            <span className={styles.ioLabel}>输出</span>
            {stage.ok ? (
              <pre className={styles.ioBox}>{stage.output}</pre>
            ) : (
              <span className={styles.ioError}>{stage.error ?? "变换失败"}</span>
            )}
          </div>
          <div className={styles.ioMs}>{stage.durationMs}ms</div>
        </div>
      )}
    </div>
  );
}
