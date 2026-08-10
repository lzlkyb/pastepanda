/**
 * AiQuickBar.tsx —— v6.4 主窗口 AI 感知（方案 B）：复制后列表上方的 AI 快捷动作区。
 *
 * 交互（对照 design/ai-quickbar-demo.html）：
 * - 复制内容（history[0] 变化）→ 按内容特征给出 2-3 个动作 + 「更多…」→ 变换面板；
 * - 点动作直接运行：AI 思考中 → 结果展开（预览 + 复制/粘贴）；本地动作（脱敏/摘要）零成本即时；
 * - 敏感内容 → 确认条（确认后 force 重跑）；出错一律给「去设置 AI / 去调整预算」出口；
 * - ✕ 关闭当前内容的快捷区（换内容重新出现）。
 *
 * 门控（规则 15）：AI 不可用（未启用 / 没配密钥）时，需要 AI 的动作在
 * matchQuickActions 里就过滤掉了——结果只剩本地动作或整条不渲染，绝不摆一排
 * 点下去只会报错的按钮。App 那边的渲染条件只决定「用快捷区还是原建议条」，
 * 不代表 AI 一定可用，所以可用性必须在这里自己再判一次。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles, X, Loader2, Copy, ClipboardPaste, ShieldAlert } from "lucide-react";
import { useAppStore } from "@/stores/appStore";
import { useDialogStore } from "@/stores/dialogStore";
import { getTransform, isAiAvailable } from "@/lib/transforms";
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
  /** 错误分类：来自 aiRun 三态的 meta 或本地判定，属结构化信息——勿回到用 message.includes 猜错误类型 */
  errKind?: "budget" | "notReady" | "other";
}

const EMPTY: ActionState = { status: "idle" };

export const AiQuickBar = memo(function AiQuickBar() {
  const { toast } = useToast();
  const topItem = useAppStore((s) => s.history[0]);
  const text = (topItem?.text || "").trim();
  const key = topItem?.id ?? "";

  /**
   * AI 是否可用：用与变换面板同一个判据 isAiAvailable()，保证「快捷区推的动作」与
   * 「更多… 面板里能选的动作」不会一边有一边没。它是模块级缓存的同步值
   * （设置改完会调 refreshAiAvailability），每次渲染现读即可。
   */
  const aiOk = isAiAvailable();

  // 按内容匹配动作（内容或 AI 可用性变化即重算）
  const actions = useMemo(
    () => (topItem ? matchQuickActions(text, topItem.content_type || topItem.type, aiOk) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [topItem?.id, topItem?.text, aiOk],
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
      if (!t) {
        // 动作没注册上（启动时 aiListActions 失败 / 后端未就绪）。这里以前是直接 return，
        // 状态停在 idle：不 loading、不报错、不提示，用户点了完全没反应，只会以为程序卡了。
        patch(
          a.id,
          {
            status: "error",
            message: "这个动作暂时不可用（AI 服务未就绪），可检查 AI 设置或重启应用",
            errKind: "notReady",
          },
          gen,
        );
        return;
      }
      patch(a.id, { status: "loading" }, gen);
      try {
        const r = await t.run(text, force ? { force: true } : undefined);
        if (r.ok) {
          patch(a.id, { status: "done", output: r.output, meta: r.meta }, gen);
        } else if (r.meta?.needsConfirm) {
          patch(a.id, { status: "confirm", message: r.message }, gen);
        } else if (r.meta?.budgetExceeded) {
          // 超预算是 aiRun 三态里的独立一支（meta.budgetExceeded），据此分类；
          // 后端给的 message 已带具体金额，比自己拼一句更有用
          patch(a.id, { status: "error", message: r.message || "今日 AI 花费已达上限", errKind: "budget" }, gen);
        } else {
          patch(a.id, { status: "error", message: r.message || "执行失败", errKind: "other" }, gen);
        }
      } catch (e) {
        patch(a.id, {
          status: "error",
          message: typeof e === "string" ? e : "执行失败",
          errKind: "other",
        }, gen);
      }
    },
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
                  className={`${styles.q}${a.ai ? ` ${styles.qAi}` : ""}${st.status === "loading" ? ` ${styles.qRunning}` : ""}`}
                  onClick={() => void runAction(a)}
                  disabled={st.status === "loading"}
                  title={
                    a.ai
                      ? `${a.label}（AI 服务：这条内容会发送给你配的服务商，按用量计费）`
                      : `${a.label}（本地处理，不出网、零成本）`
                  }
                >
                  {st.status === "loading" ? (
                    <Loader2 size={11} className="spin" />
                  ) : a.ai ? (
                    // 计费动作必须在点之前就看得出来：✦ 前缀 + accent 描边；本地动作保持中性
                    <span className={styles.aiMark} aria-hidden="true">✦</span>
                  ) : null}
                  {/* 本地动作不能说「AI 思考中」（反向误导：让免费动作看起来在花钱/出网） */}
                  {st.status === "loading" ? (a.ai ? "AI 思考中…" : "处理中…") : a.label}
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
                {/* 本地动作别说「AI 思考中」——那是在告诉用户一个免费动作正在花钱/出网 */}
                <div className={styles.thinking}>
                  <Loader2 size={13} className="spin" /> {a.ai ? "AI 思考中…" : "处理中…"}
                </div>
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
                {/* 出错一律给出口：以前只有文案里带「预算」二字才有按钮，
                    「未配置 API Key」这种明明可操作的错反而让用户自己猜去哪配。
                    分类用结构化的 errKind，不再 includes 文案。 */}
                <button className={styles.gbBtn} onClick={() => void openAiSettings()}>
                  {st.errKind === "budget" ? "去调整预算" : "去设置 AI"}
                </button>
              </div>
            );
          }
          // done
          return (
            <div key={a.id} className={styles.resultBar}>
              <div className={styles.rhead}>
                {/* ✦ 只给走了 AI 的结果；本地动作标「本地」，两者不能长得一样 */}
                {a.ai ? "✦ " : ""}
                {a.label}
                {st.meta?.model ? ` · ${st.meta.model}` : a.ai ? "" : " · 本地"}
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
