import { useCallback, useEffect, useRef, useState } from "react";
import { getTransform, type Transform, type TransformResultMeta } from "@/lib/transforms";
import { onAiChunk, ensureAiChunkListener } from "@/lib/useAiStream";
import { useToast } from "@/components/Toast";

type Preview =
  /** 云端动作/执行类动作：等用户点“运行/执行”，在那之前什么都不发 */
  | { state: "idle" }
  | { state: "loading"; streamText?: string }
  | {
      state: "ok";
      output: string;
      meta?: TransformResultMeta;
      /** v6.10 追问：多轮问题/答案 */
      followQs?: string[];
      followAs?: string[];
      followPending?: boolean;
    }
  /** 仅执行类动作：run() 成功但无产物（副作用已完成） */
  | { state: "done" }
  | {
      state: "err";
      message: string;
      /** 内容看起来是密钥，后端拒发了，等用户确认 */
      needsConfirm?: boolean;
      budgetExceeded?: boolean;
      /** v6.9：内置免费额度不足（引导签到/兑换而非调预算） */
      isQuota?: boolean;
    };

export function useTransformPreview({ t, text, opts, html, userTags }: {
  t: Transform;
  text: string;
  opts: Record<string, string>;
  html?: string;
  userTags?: string;
}) {
  const isRemote = !!t.remote;
  const isAction = t.kind === "action";
  const { toast } = useToast();
  const [preview, setPreview] = useState<Preview>(
    isRemote || isAction ? { state: "idle" } : { state: "loading" },
  );
  // 审查：execute 竞态防护 —— 远程动作运行中用户改 chip/OCR 更新文本，
  // 旧请求晚到会覆盖新上下文的结果；代际计数让过期结果直接丢弃。
  const runSeqRef = useRef(0);

  const execute = useCallback(
    async (force: boolean) => {
      const seq = ++runSeqRef.current;
      setPreview({ state: "loading", streamText: "" });
      // v6.10 流式：远程动作注册增量监听（打字机）。
      // 先 await 监听就绪再发请求（同 AiQuickBar）：listen() 异步注册，不等会丢首次开头几块
      if (isRemote) await ensureAiChunkListener();
      const offStream = isRemote
        ? onAiChunk(t.id, (d) => {
            if (runSeqRef.current !== seq) return;
            setPreview((p) =>
              p.state === "loading"
                ? { state: "loading", streamText: (p.streamText ?? "") + d }
                : p
            );
          })
        : () => {};
      const r = await t.run(text, {
        ...opts,
        ...(html ? { html } : {}),
        ...(userTags ? { userTags } : {}),
        ...(force ? { force: true } : {}),
      });
      offStream();
      if (runSeqRef.current !== seq) return; // 有新请求/内容变化，丢弃过期结果
      if (r.ok && r.output !== undefined) {
        setPreview({ state: "ok", output: r.output, meta: r.meta });
      } else if (r.ok && isAction) {
        // 执行类动作：ok 但无产物 = 副作用已完成
        setPreview({ state: "done" });
      } else {
        setPreview({
          state: "err",
          message: r.message ?? "无法转换",
          needsConfirm: r.meta?.needsConfirm === true,
          budgetExceeded: r.meta?.budgetExceeded === true,
          isQuota: r.meta?.isQuota === true,
        });
      }
    },
    [t, text, opts, html, userTags, isAction, isRemote]
  );

  // v6.10 追问：对云端动作结果继续处理（ai-followup）
  const runFollowup = useCallback(
    async (q: string) => {
      if (preview.state !== "ok" || preview.followPending) return;
      const ft = getTransform("ai-followup");
      if (!ft) {
        toast(`追问暂不可用：${"AI 服务未就绪"}`, "error");
        return;
      }
      setPreview((p) =>
        p.state === "ok"
          ? { ...p, followPending: true, followQs: [...(p.followQs ?? []), q] }
          : p
      );
      const content = `${q}\n\n（上次结果）\n${preview.output}`;
      try {
        const r = await ft.run(content);
        setPreview((p) => {
          if (p.state !== "ok") return p;
          const answers = [...(p.followAs ?? [])];
          if (r.ok && r.output !== undefined) answers.push(r.output);
          else answers.push(`（追问失败：${r.message ?? "未知错误"}）`);
          return { ...p, followPending: false, followAs: answers };
        });
      } catch (e) {
        setPreview((p) =>
          p.state === "ok"
            ? {
                ...p,
                followPending: false,
                followAs: [...(p.followAs ?? []), `（追问失败：${typeof e === "string" ? e : "未知错误"}）`],
              }
            : p
        );
      }
    },
    [preview, toast]
  );

  useEffect(() => {
    // 审查：内容/选项变化 → 作废在途 execute（旧请求晚到不再覆盖新结果）
    runSeqRef.current += 1;
    // 云端动作 / 执行类动作：不自动跑。前者避免打开面板就发内容花钱，
    // 后者避免打开面板就执行副作用（打开浏览器/资源管理器）。
    if (isRemote || isAction) {
      setPreview({ state: "idle" });
      return;
    }
    let cancelled = false;
    const result = t.run(text, { ...opts, ...(html ? { html } : {}), ...(userTags ? { userTags } : {}) });
    if (result instanceof Promise) {
      setPreview({ state: "loading" });
      result.then((r) => {
        if (cancelled) return;
        setPreview(
          r.ok && r.output !== undefined
            ? { state: "ok", output: r.output, meta: r.meta }
            : { state: "err", message: r.message ?? "无法转换" }
        );
      });
    } else {
      setPreview(
        result.ok && result.output !== undefined
          ? { state: "ok", output: result.output, meta: result.meta }
          : { state: "err", message: result.message ?? "无法转换" }
      );
    }
    return () => { cancelled = true; };
  }, [t, text, opts, html, userTags, isRemote, isAction]);

  return { preview, execute, runFollowup };
}
