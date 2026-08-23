/**
 * useAiQuickRun —— AI 快捷区的**执行编排**（从 AiQuickBar 抽出，规则 #7）。
 *
 * 抽这一层而不是只抽渲染：一个动作从点下去到出结果要跨 5 个回调
 * （run / followup / revert / collapse / copy+paste），它们共用同一堆状态（states）
 * 与同一道守卫（genRef），摆在组件里就是 200 行与 UI 无关的代码。
 *
 * **代际守卫 genRef 是这里最要紧的东西**：内容切换后，旧 promise 的回写必须
 * 丢弃，否则在途结果会落到新内容的卡片上。新增任何异步回写都要先拿 gen 对一下。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getTransform } from "@/lib/transforms";
import type { QuickAction } from "@/lib/aiQuick";
import type { ActionState } from "@/components/ai/quickTypes";
import { pasteTextGuarded } from "@/lib/api";
import { manualTagsOpt } from "@/lib/aiTags";
import { onAiChunk, ensureAiChunkListener } from "@/lib/useAiStream";
import { useActionEventLog } from "@/hooks/useActionEventLog";
import { useDialogStore } from "@/stores/dialogStore";
import type { HistoryItem } from "@/stores/appStore";

export interface AiQuickRun {
  states: Record<string, ActionState>;
  runAction: (a: QuickAction, force?: boolean) => Promise<void>;
  runFollowup: (a: QuickAction, prompt: string) => Promise<void>;
  revert: (a: QuickAction) => void;
  continueWith: (a: QuickAction) => void;
  toggleCollapse: (actionId: string) => void;
  copy: (a: QuickAction, out: string) => Promise<void>;
  paste: (a: QuickAction, out: string) => Promise<void>;
  /** 敏感确认条的“取消”：抹回 idle（整张卡消失） */
  cancelConfirm: (actionId: string) => void;
}

export function useAiQuickRun(opts: {
  item: HistoryItem | undefined;
  /** 动作的实际输入（文件/图片条目是从路径派生的，不等于 item.text） */
  text: string;
  toast: (msg: string, kind?: "success" | "error") => void;
}): AiQuickRun {
  const { item, text, toast } = opts;
  const [states, setStates] = useState<Record<string, ActionState>>({});

  // 行为埋点：本区是 AI 动作的**主入口**，之前一直没记事件，
  // 导致 AI 动作在推荐排序里的权重恒为缺失（除非用户绕路从变换中心用）
  const logEvent = useActionEventLog(item?.content_type || item?.type || "text", item?.source, item?.id);

  /** 代际计数：内容变化后，旧 promise 的 patch 直接丢弃（防在途结果污染新内容） */
  const genRef = useRef(0);

  // 新内容 → 清空结果并推进一代。
  // 注：AiQuickBar 那边还有一个同依赖的 effect 负责重置 closed，
  // 两边各自拥有自己的状态，但**触发条件必须一致**（id + text）。
  useEffect(() => {
    genRef.current += 1;
    setStates({});
  }, [item?.id, item?.text]);

  const patch = useCallback((actionId: string, s: ActionState, gen: number) => {
    if (genRef.current !== gen) return; // 内容已切换，丢弃过期结果
    setStates((prev) => ({ ...prev, [actionId]: s }));
  }, []);

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
      patch(a.id, { status: "loading", streamText: "" }, gen);
      // 流式：注册增量监听，loading 期间打字机渲染。
      // 先 await 监听就绪再发请求：listen() 是异步注册，不等就 invoke 会丢掉首次的开头几块
      await ensureAiChunkListener();
      const offStream = onAiChunk(a.id, (d) => {
        if (genRef.current !== gen) return;
        setStates((prev) => {
          const cur = prev[a.id];
          if (!cur || cur.status !== "loading") return prev;
          return { ...prev, [a.id]: { ...cur, streamText: (cur.streamText ?? "") + d } };
        });
      });
      try {
        // userTags：手工标签名，给后端的 ai_tags_as_context 用（开关在后端，这里无条件传）。
        // 它会进缓存 key —— 标签变了 prompt 就变了，旧结果不该再命中。
        const tags = manualTagsOpt(item?.tags);
        const r = await t.run(text, {
          ...(force ? { force: true } : {}),
          ...(tags ? { userTags: tags } : {}),
        });
        offStream();
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
        offStream();
        patch(
          a.id,
          { status: "error", message: typeof e === "string" ? e : "执行失败", errKind: "other" },
          gen,
        );
      }
    },
    [text, patch, item?.tags],
  );

  // 追问：对已完成结果继续处理（ai-followup），多轮叠加在同卡
  const runFollowup = useCallback(
    async (a: QuickAction, prompt: string) => {
      const gen = genRef.current;
      const q = prompt.trim();
      if (!q) return;
      const cur = states[a.id];
      if (!cur || cur.status !== "done" || cur.followPending) return;
      const t = getTransform("ai-followup");
      if (!t) {
        toast("追问暂不可用（AI 服务未就绪）", "error");
        return;
      }
      setStates((prev) => {
        const c = prev[a.id];
        if (!c) return prev;
        return {
          ...prev,
          [a.id]: { ...c, followPending: true, followQs: [...(c.followQs ?? []), q] },
        };
      });
      // 内容 = 追问 + 上次结果（prompt 模板已说明结构）
      const content = `${q}\n\n（上次结果）\n${cur.output ?? ""}`;
      const appendAnswer = (ans: string) => {
        setStates((prev) => {
          const c = prev[a.id];
          if (!c) return prev;
          return { ...prev, [a.id]: { ...c, followPending: false, followAs: [...(c.followAs ?? []), ans] } };
        });
      };
      try {
        const r = await t.run(content);
        // 与 runAction 的 patch 同一道守卫：追问期间剪贴板内容已切换时，
        // 旧结果不能再写回新内容的卡片
        if (genRef.current !== gen) return;
        appendAnswer(r.ok && r.output !== undefined ? r.output : `（追问失败：${r.message ?? "未知错误"}）`);
      } catch (e) {
        if (genRef.current !== gen) return; // 同上：过期的失败也不该写回新卡片
        appendAnswer(`（追问失败：${typeof e === "string" ? e : "未知错误"}）`);
      }
    },
    [states, toast],
  );

  // 回退：还原到处理前原文
  const revert = useCallback((a: QuickAction) => {
    setStates((prev) => {
      const cur = prev[a.id];
      if (!cur || cur.status !== "done" || cur.reverted) return prev;
      return { ...prev, [a.id]: { ...cur, reverted: true } };
    });
  }, []);

  // 继续处理：把结果喂给下一个动作（打开变换中心并预填）
  const continueWith = useCallback(
    (a: QuickAction) => {
      const out = states[a.id]?.output;
      if (!item || !out) return;
      useDialogStore.getState().openHub(item, out);
    },
    [states, item],
  );

  const toggleCollapse = useCallback((actionId: string) => {
    setStates((prev) => {
      const cur = prev[actionId];
      if (!cur || cur.status !== "done") return prev;
      return { ...prev, [actionId]: { ...cur, collapsed: !cur.collapsed } };
    });
  }, []);

  const cancelConfirm = useCallback(
    (actionId: string) => patch(actionId, { status: "idle" }, genRef.current),
    [patch],
  );

  const copy = useCallback(
    async (a: QuickAction, out: string) => {
      try {
        await navigator.clipboard.writeText(out);
        // 复制成功 = 用户认可这个动作的产物，与变换中心同一口径
        logEvent(a.id, "copied");
        toast(`已复制「${a.label}」结果`, "success");
      } catch {
        toast("复制失败", "error");
      }
    },
    [logEvent, toast],
  );

  const paste = useCallback(
    async (a: QuickAction, out: string) => {
      const ok = await pasteTextGuarded(out);
      if (ok) {
        // 粘贴成功 = 内容真正被用上，最有价值的信号
        logEvent(a.id, "pasted");
        toast(`已粘贴「${a.label}」结果`, "success");
      }
    },
    [logEvent, toast],
  );

  return {
    states,
    runAction,
    runFollowup,
    revert,
    continueWith,
    toggleCollapse,
    copy,
    paste,
    cancelConfirm,
  };
}
