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

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X, Play, RotateCcw, Copy, Check, ClipboardPaste, Loader2,
  ShieldAlert, CheckCircle2, Plus, Pencil,
} from "lucide-react";
import { useDialogStore } from "@/stores/dialogStore";
import { PRESET_CHAINS, getChainAsync, loadUserChains, runChain } from "@/lib/chains/registry";
import type { Chain, ChainRunResult, ChainRunStage } from "@/lib/chains/types";
import { pasteText } from "@/lib/api";
import { useToast } from "@/components/Toast";
import { useDialogAnim } from "@/lib/dialogMotion";
import { FocusTrap } from "@/components/FocusTrap";
import { SequenceDiscover } from "@/components/SequenceDiscover";
import { AiBadge } from "@/components/AiBadge";
import styles from "./ChainRunnerDialog.module.css";

export function ChainRunnerDialog() {
  const text = useDialogStore((s) => s.chainText);
  /** AI 临时编的链（B）：不在注册表里，只在本次会话有效 */
  const adHoc = useDialogStore((s) => s.chainAdHoc);
  const close = useCallback(() => useDialogStore.getState().closeChain(), []);
  const open = text !== null;
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
  }, [open, text]);

  const chain = useMemo(
    () => allChains.find((c) => c.id === chainId) ?? PRESET_CHAINS[0],
    [allChains, chainId],
  );
  const originText = text ?? "";

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
    const ok = await pasteText(out);
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

              {/* V3-B 程序性记忆：高频操作 → 一键存成链 */}
              <SequenceDiscover open={open} />

              {/* 链选择：自定义链在前，预置链在后 */}
              <div className={styles.chainRow}>
                <div className={styles.chainPicks}>
                  {allChains.map((c) => (
                    <button
                      key={c.id}
                      className={`${styles.chainPick} ${c.id === chainId ? styles.chainPickOn : ""}`}
                      onClick={() => { setChainId(c.id); setResult(null); }}
                    >
                      <span className={styles.chainPickName}>
                        {c.name}
                        {/* AI 临时链标上 AI：它与用户亲手配的链混在同一列表里，
                            不标就分不清“这条是模型刚编的、没存过” */}
                        {adHoc && c.id === adHoc.id && <AiBadge kind="ai" size="xs" />}
                      </span>
                      <span className={styles.chainPickDesc}>{c.description}</span>
                      {!isPreset(c.id) && (
                        <span
                          className={styles.chainEdit}
                          title={
                            adHoc && c.id === adHoc.id ? "存为我的链" : "编辑这条链"
                          }
                          onClick={(e) => {
                            e.stopPropagation();
                            editChain(c);
                          }}
                        >
                          <Pencil size={11} />
                        </span>
                      )}
                    </button>
                  ))}
                </div>
                <button
                  className={styles.newBtn}
                  onClick={() => useDialogStore.getState().openChainEditor(null)}
                >
                  <Plus size={13} /> 新建链
                </button>
              </div>

              {/* 当前输入 */}
              <div className={styles.inputBox}>
                <div className={styles.inputHead}>
                  <span>输入（{input.length} 字）</span>
                  {input !== originText && (
                    <button className={styles.resetBtn} onClick={() => setInput(originText)}>
                      <RotateCcw size={12} /> 撤销到原始
                    </button>
                  )}
                </div>
                <pre className={styles.inputPreview}>{input || "（空）"}</pre>
              </div>

              {/* 运行 */}
              <div className={styles.runRow}>
                <button
                  className={styles.runBtn}
                  onClick={() => void run()}
                  disabled={running || !input}
                >
                  {running ? <Loader2 size={13} className="spin" /> : <Play size={13} />}
                  {running ? "运行中…" : "运行整条链"}
                </button>
                <span className={styles.stepHint}>
                  {chain.steps.length} 步 · {chain.steps.some((s) => s.risk === "network") ? "含 AI 步骤（运行到会先确认）" : "全部本地变换"}
                </span>
              </div>

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

              {/* 步骤流 */}
              {result && (
                <div className={styles.steps}>
                  {result.stages.map((s, i) => (
                    <StepCard
                      key={i}
                      stage={s}
                      index={i}
                      expanded={expanded.has(i)}
                      onToggle={() => toggleStep(i)}
                    />
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

              {/* 最终结果 */}
              {result && (
                <div className={styles.finalBox}>
                  <div className={styles.finalHead}>
                    <span>{result.ok ? "最终结果" : "中间结果（保留到失败前）"}</span>
                  </div>
                  <pre className={styles.finalPreview}>{result.final}</pre>
                  <div className={styles.finalActions}>
                    <button
                      className={copied ? styles.copyDone : styles.copyBtn}
                      onClick={() => void copy()}
                      disabled={!result.final}
                    >
                      {copied ? <Check size={13} /> : <Copy size={13} />}
                      {copied ? "已复制" : "复制"}
                    </button>
                    <button className={styles.pasteBtn} onClick={() => void paste()} disabled={!result.final}>
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
  return (
    <div className={`${styles.step} ${stage.ok ? styles.stepOk : styles.stepFail}`}>
      <div className={styles.stepHead} onClick={onToggle} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}>
        <span className={styles.stepIdx}>{index + 1}</span>
        <span className={styles.stepLabel}>{stage.label}</span>
        <span className={stage.risk === "destructive" ? styles.riskDanger : styles.riskLocal}>
          {stage.risk === "destructive" ? "修改" : "本地"}
        </span>
        {stage.ok ? (
          <CheckCircle2 size={14} className={styles.stepOkIcon} />
        ) : (
          <ShieldAlert size={14} className={styles.stepFailIcon} />
        )}
      </div>
      {expanded && (
        <div className={styles.stepDetail}>
          <div className={styles.stepIo}>
            <span className={styles.ioLabel}>输入</span>
            <pre className={styles.ioPreview}>{stage.input || "（空）"}</pre>
          </div>
          <div className={styles.stepIo}>
            <span className={styles.ioLabel}>输出</span>
            {stage.ok ? (
              <pre className={styles.ioPreview}>{stage.output}</pre>
            ) : (
              <span className={styles.stepError}>{stage.error ?? "变换失败"}</span>
            )}
          </div>
          <div className={styles.stepMeta}>{stage.durationMs}ms</div>
        </div>
      )}
    </div>
  );
}
