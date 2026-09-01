/**
 * useKbQa.ts —— 知识库问答的会话状态机（B2 #10 / #10b）。
 *
 * 分开成 hook 而不写进 `KnowledgeView`：那个文件已经 400+ 行（规则 #7 上限 300）。
 *
 * # 两步，且第一步不出网
 *
 * 1. **本地检索**（`note_search_relevant`，FTS5 OR + BM25）——不出网；
 * 2. 命中了才拼载荷走 `ai_run`。**零命中直接结束，不发请求、不花钱**。
 *
 * # 四种返回全得接
 *
 * `ai_run` 自己的注释写得很清楚：「需要确认」与「超预算」**不是错误，
 * 是需要界面分支处理的正常结果**。而 `needsConfirm` 必须**真的问一句**，
 * 不能直接带 `force` 重跑——那就把那道门废了。
 *
 * # 流式的三条限制（全是 `useAiStream.ts` 自述的）
 *
 * 1. `listen()` 是异步的，紧接着 invoke 会丢开头几块 → 发请求**之前**
 *    `await ensureAiChunkListener()`；
 * 2. emit 的 payload **没有 per-call id**，同一 actionId 并发会混流 → 本 hook 同时
 *    只跑一个（`busy` 时 UI 禁用输入），并用**代际守卫**丢弃过期回调；
 * 3. **本地厂商（Ollama）不发流** → 流式只是锦上添花，没收到 chunk 就安静等
 *    最终结果，**不能卡在「正在问…」不动**。
 *
 * **最终文本以 `ai_run` 的返回值为准**，拿到后直接覆盖流式累积的串——
 * 流式只管预览，不管正确性。与现有两个调用方口径一致。
 *
 * 🔴 **会话不持久化**：不建表、不落库，关面板 / 切回搜就没。
 */
import { useCallback, useRef, useState } from "react";
import { aiRun, noteSearchRelevant, type Note, type FolderFilter } from "@/lib/api";
import { ensureAiChunkListener, onAiChunk } from "@/lib/useAiStream";
import type { NoteViewOpts } from "@/lib/notes/viewOpts";
import {
  buildQaPayload,
  retrievalQuery,
  QA_TOP_K,
  type QaPayload,
  type QaTurn,
} from "@/lib/notes/kbQa";
import { logger } from "@/lib/logger";

/** 进行中 / 需要拍板 / 出错的那一轮。已完成的轮次在 `turns` 里 */
export type KbQaPending =
  /** 正在跑。`streamed` 是流式累积，未收到 chunk 时为空串 */
  | { kind: "running"; question: string; streamed: string }
  /** 零命中。**未发请求** */
  | { kind: "empty"; question: string }
  /** 出网闸拦下了，等用户拍板 */
  | { kind: "confirm"; question: string; reason: string }
  | { kind: "error"; question: string; message: string };

export interface KbQaSession {
  /** 已完成的轮次，按时间升序 */
  turns: QaTurn[];
  pending: KbQaPending | null;
}

/** 问答的检索范围 = 用户眼前那个范围。 */
export interface KbQaScope {
  folderFilter: FolderFilter;
  tagIds: string[];
  view: NoteViewOpts;
}

const EMPTY: KbQaSession = { turns: [], pending: null };

export function useKbQa(scope: KbQaScope) {
  const [session, setSession] = useState<KbQaSession>(EMPTY);
  // 待确认时要能原样重发，所以把载荷留着。重新检索一遍也行，
  // 但那样用户确认的内容与真正发出去的内容可能不是同一份。
  const pendingPayloadRef = useRef<QaPayload | null>(null);
  // 代际守卫：新一轮 / reset 都 +1，过期的流式与完成回调一律丢弃。
  // 必需：`ai-run-chunk` 的 payload 没有 per-call id，靠它自己分不了流。
  const genRef = useRef(0);
  // 已完成轮次的**真相源**。不能靠 `setSession` 的 updater 去读：
  // updater 是渲染时才跑的，写在里面取值下一行读到的还是 undefined。
  // 也不把 `session` 放进 `ask` 的依赖：每答一轮就重建一次 ask，白搞。
  const turnsRef = useRef<QaTurn[]>([]);

  const busy = session.pending?.kind === "running";

  const send = useCallback(async (payload: QaPayload, question: string, force: boolean) => {
    const gen = ++genRef.current;
    setSession((s) => ({ ...s, pending: { kind: "running", question, streamed: "" } }));

    // 必须在 invoke **之前** await，否则开头几块 delta 落空（useAiStream 自述限制 1）
    await ensureAiChunkListener();
    const off = onAiChunk("ai-kb-qa", (delta) => {
      if (gen !== genRef.current) return; // 过期回调
      setSession((s) =>
        s.pending?.kind === "running"
          ? { ...s, pending: { ...s.pending, streamed: s.pending.streamed + delta } }
          : s,
      );
    });

    try {
      const res = await aiRun("ai-kb-qa", payload.text, undefined, force);
      if (gen !== genRef.current) return;

      if (res.status === "needsConfirm") {
        pendingPayloadRef.current = payload;
        setSession((s) => ({ ...s, pending: { kind: "confirm", question, reason: res.reason } }));
        return;
      }
      if (res.status === "budgetExceeded") {
        // 不假装成网络错误：后端给的金额比自己拼一句有用
        const message = res.isQuota
          ? "内置免费额度已用完"
          : `今日 AI 花费已达上限（已花 ¥${res.spentCny.toFixed(2)} / 上限 ¥${res.budgetCny.toFixed(2)}）`;
        setSession((s) => ({ ...s, pending: { kind: "error", question, message } }));
        return;
      }

      // 流式只管预览：最终文本一律以返回值为准
      const turn: QaTurn = {
        question,
        answer: res.content.trim(),
        refs: payload.refs,
        cached: res.cached,
        truncated: res.truncated,
      };
      turnsRef.current = [...turnsRef.current, turn];
      setSession({ turns: turnsRef.current, pending: null });
    } catch (e) {
      if (gen !== genRef.current) return;
      logger.error("问知识库失败", e);
      setSession((s) => ({ ...s, pending: { kind: "error", question, message: String(e) } }));
    } finally {
      off();
    }
  }, []);

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q) return;

      const gen = ++genRef.current;
      setSession((s) => ({ ...s, pending: { kind: "running", question: q, streamed: "" } }));

      // 多轮：拿上一轮做指代上下文，且**重新检索**——沿用旧片段会把
      // 「那回滚呢」答成「知识库中没有相关笔记」，而库里明明有。
      const prev = turnsRef.current[turnsRef.current.length - 1];

      let notes: Note[];
      try {
        notes = await noteSearchRelevant(retrievalQuery(q, prev?.question), {
          folderFilter: scope.folderFilter,
          tagIds: scope.tagIds,
          view: scope.view,
          limit: QA_TOP_K,
        });
      } catch (e) {
        if (gen !== genRef.current) return;
        // 检索挂了不能说成「库里没有」——那是个看不出来的错答案
        logger.error("问答检索失败", e);
        setSession((s) => ({
          ...s,
          pending: { kind: "error", question: q, message: `检索失败：${String(e)}` },
        }));
        return;
      }
      if (gen !== genRef.current) return;

      if (notes.length === 0) {
        setSession((s) => ({ ...s, pending: { kind: "empty", question: q } }));
        return;
      }
      await send(buildQaPayload(q, notes, prev), q, false);
    },
    [scope.folderFilter, scope.tagIds, scope.view, send],
  );

  /** 用户在出网确认上点了「仍要发送」 */
  const confirmSend = useCallback(() => {
    const p = pendingPayloadRef.current;
    const q = session.pending?.kind === "confirm" ? session.pending.question : null;
    if (!p || !q) return;
    void send(p, q, true);
  }, [send, session.pending]);

  /** 关面板 / 切回搜：整个会话丢掉（不落库，本来也没处可存） */
  const reset = useCallback(() => {
    genRef.current++;
    pendingPayloadRef.current = null;
    turnsRef.current = [];
    setSession(EMPTY);
  }, []);

  return { session, ask, confirmSend, reset, busy };
}
