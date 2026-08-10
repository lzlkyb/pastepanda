/**
 * AiQuickBar.tsx —— v6.4 主窗口 AI 感知（方案 B）：复制后列表上方的 AI 快捷动作区。
 *
 * 交互（对照 design/ai-quickbar-demo.html）：
 * - 复制内容（history[0] 变化）→ 按内容特征给出 2-3 个动作 + 「更多…」→ 变换面板；
 * - 点动作直接运行：AI 思考中 → 结果展开（预览 + 复制/粘贴）；本地动作（脱敏/摘要）零成本即时；
 * - 敏感内容 → 确认条（确认后 force 重跑）；预算超限 → 「去调整」跳设置；
 * - ✕ 关闭当前内容的快捷区（换内容重新出现）。
 *
 * 只在 AI 已启用时由 App 渲染（替代 SuggestionBar）。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles, X, Loader2, Copy, Check, ClipboardPaste, ShieldAlert } from "lucide-react";
import { useAppStore } from "@/stores/appStore";
import { useDialogStore } from "@/stores/dialogStore";
import { getTransform } from "@/lib/transforms";
import { matchQuickActions, type QuickAction } from "@/lib/aiQuick";
import { pasteText } from "@/lib/api";
import { openAiSettings } from "@/lib/openAiSettings";
import { useToast } from "@/components/Toast";
import type { TransformResultMeta } from "@/lib/transforms";
import styles from "./AiQuickBar.module.css";

/** 结果元信息显式类型（extends 保持与宽松 TransformResultMeta 的双向兼容） */
interface QuickMeta extends TransformResultMeta {
  model?: string;
  cached?: boolean;
  truncated?: boolean;
  needsConfirm?: boolean;
  budgetExceeded?: boolean;
}

interface ActionState {
  status: "idle" | "loading" | "done" | "confirm" | "error";
  output?: string;
  message?: string;
  meta?: QuickMeta;
}

const EMPTY: ActionState = { status: "idle" };

export const AiQuickBar = memo(function AiQuickBar() {
  const { toast } = useToast();
  const topItem = useAppStore((s) => s.history[0]);
  const text = (topItem?.text || "").trim();
  const key = topItem?.id ?? "";

  // 按内容匹配动作（内容变化即重算）
  const actions = useMemo(
    () => (topItem ? matchQuickActions(text, topItem.content_type || topItem.type) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [topItem?.id, topItem?.text],
  );
  const [closed, setClosed] = useState(false);
  const [states, setStates] = useState<Record<string, ActionState>>({});
  /** 审查 #9：内容代际计数——内容变化后，旧 promise 的 patch 直接丢弃（防在途结果污染新内容） */
  const genRef = useRef(0);

  // 新内容 → 重置（快捷区重新出现）
  useEffect(() => {
    genRef.current += 1;
    setClosed(false);
    setStates({});
  }, [topItem?.id, topItem?.text]);

  const patch = (actionId: string, s: ActionState, gen: number) => {
    if (genRef.current !== gen) return; // 内容已切换，丢弃过期结果
    setStates((prev) => ({ ...prev, [actionId]: s }));
  };

  const runAction = useCallback(
    async (a: QuickAction, force = false) => {
      const gen = genRef.current;
      const t = getTransform(a.id);
      if (!t) return;
      patch(a.id, { status: "loading" }, gen);
      try {
        const r = await t.run(text, force ? { force: true } : undefined);
        if (r.ok) {
          patch(a.id, { status: "done", output: r.output, meta: r.meta }, gen);
        } else if (r.meta?.needsConfirm) {
          patch(a.id, { status: "confirm", message: r.message }, gen);
        } else if (r.meta?.budgetExceeded) {
          patch(a.id, { status: "error", message: "今日 AI 预算已用完" }, gen);
        } else {
          patch(a.id, { status: "error", message: r.message || "执行失败" }, gen);
        }
      } catch (e) {
        patch(a.id, {
          status: "error",
          message: typeof e === "string" ? e : "执行失败",
        }, gen);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [text]
  );

  /** 更多 → 打开变换面板并定位 */
  const openMore = useCallback(() => {
    if (!topItem) return;
    useDialogStore.getState().openHub(topItem, text);
  }, [topItem, text]);

  const copy = async (a: QuickAction, out: string) => {
    try {
      await navigator.clipboard.writeText(out);
      toast(`已复制「${a.label}」结果`, "success");
    } catch {
      toast("复制失败", "error");
    }
  };

  const paste = async (a: QuickAction, out: string) => {
    const ok = await pasteText(out);
    if (ok) toast(`已粘贴「${a.label}」结果`, "success");
  };

  if (!topItem || actions.length === 0 || closed) return null;
  const active = states[actions[0]?.id ?? ""] ?? EMPTY;

  return (
    <AnimatePresence>
      <motion.div
        key={key}
        className={styles.wrap}
        initial={{ opacity: 0, y: -8, height: 0 }}
        animate={{ opacity: 1, y: 0, height: "auto" }}
        exit={{ opacity: 0, y: -8, height: 0 }}
        transition={{ duration: 0.18 }}
      >
        <div className={styles.bar}>
          <span className={styles.lbl}><Sparkles size={11} /> AI</span>
          <div className={styles.acts}>
            {actions.map((a) => {
              const st = states[a.id] ?? EMPTY;
              return (
                <button
                  key={a.id}
                  className={`${styles.q}${st.status === "loading" ? ` ${styles.qRunning}` : ""}`}
                  onClick={() => void runAction(a)}
                  disabled={st.status === "loading"}
                  title={a.ai ? `${a.label}（AI 服务）` : `${a.label}（本地处理）`}
                >
                  {st.status === "loading" ? <Loader2 size={11} className="spin" /> : null}
                  {st.status === "loading" ? "AI 思考中…" : a.label}
                </button>
              );
            })}
            <button className={`${styles.q} ${styles.more}`} onClick={openMore}>
              更多…
            </button>
          </div>
          <span className={styles.hintTxt}>
            {topItem.content_type === "link" ? "链接" : topItem.type === "text" ? "文本" : topItem.type}
          </span>
          <button className={styles.x} onClick={() => setClosed(true)} title="关闭">
            <X size={12} />
          </button>
        </div>

        {/* 结果 / 确认 / 错误区 */}
        {actions.map((a) => {
          const st = states[a.id];
          if (!st || st.status === "idle") return null;
          if (st.status === "loading") {
            return (
              <div key={a.id} className={styles.resultBar}>
                <div className={styles.thinking}><Loader2 size={13} className="spin" /> AI 思考中…</div>
              </div>
            );
          }
          if (st.status === "confirm") {
            return (
              <div key={a.id} className={`${styles.gateBar} ${styles.sens}`}>
                <ShieldAlert size={12} />
                <span>{st.message || "内容可能包含敏感信息"}</span>
                <button className={styles.gbBtn} onClick={() => void runAction(a, true)}>确认发送</button>
                <button className={styles.gbBtn} onClick={() => patch(a.id, { status: "idle" }, genRef.current)}>取消</button>
              </div>
            );
          }
          if (st.status === "error") {
            return (
              <div key={a.id} className={`${styles.gateBar} ${styles.err}`}>
                <span>{st.message}</span>
                {st.message?.includes("预算") && (
                  <button className={styles.gbBtn} onClick={() => void openAiSettings()}>去调整预算</button>
                )}
              </div>
            );
          }
          // done
          return (
            <div key={a.id} className={styles.resultBar}>
              <div className={styles.rhead}>
                ✦ {a.label} · {st.meta?.model ?? (a.ai ? "" : "本地")}
                {st.meta?.cached ? " · 缓存命中" : ""}
                {st.meta?.truncated ? " · ⚠ 被截断" : ""}
              </div>
              <div className={styles.rbody}>{st.output}</div>
              <div className={styles.racts}>
                <button className={styles.rb} onClick={() => void copy(a, st.output ?? "")}>
                  <Copy size={11} /> 复制
                </button>
                <button className={`${styles.rb} ${styles.rbPri}`} onClick={() => void paste(a, st.output ?? "")}>
                  <ClipboardPaste size={11} /> 粘贴到前台
                </button>
              </div>
            </div>
          );
        })}
      </motion.div>
    </AnimatePresence>
  );
});
