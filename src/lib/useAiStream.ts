/**
 * lib/useAiStream.ts —— v6.10 流式输出：后端 ai-run-chunk 事件分发。
 *
 * 后端 ai_run 对远程服务商逐块 emit `ai-run-chunk`（{actionId, delta}）。
 * 本模块维护 actionId → 处理器 的注册表，前端结果卡在执行动作时注册、
 * 结束后取消。两条已知限制，**都只影响打字机预览、不影响最终结果**（最终文本
 * 来自 ai_run 的返回值，调用方拿到后直接覆盖 streamText）：
 *
 * 1. `listen()` 是异步的（要往 Rust 侧注册），而 `onAiChunk` 同步返回。调用方若紧接着
 *    就 invoke，首次的开头几块会落空。为此导出 `ensureAiChunkListener()`，
 *    调用方应在发起请求**之前** await 一次。
 * 2. emit 的 payload 只有 `{actionId, delta}`，**没有单次调用的 id**。同一个 actionId
 *    同时跑两次（快捷区与变换枢纽各跑一份 ai-translate）时，两个卡片会收到同一份
 *    混合 delta。要真分流得在协议里加 per-call id（Rust + TS 同步改）；鉴于只是瞬时
 *    视觉噪声、完成即自愈，暂不改协议——但不能像原注释那样含糊写成“天然对号入座”。
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

type DeltaHandler = (delta: string) => void;

const handlers = new Map<string, Set<DeltaHandler>>();
let unlistenPromise: Promise<UnlistenFn> | null = null;

function ensureListener(): Promise<void> {
  if (unlistenPromise) return unlistenPromise.then(() => undefined);
  unlistenPromise = listen<{ actionId: string; delta: string }>("ai-run-chunk", (e) => {
    const set = handlers.get(e.payload.actionId);
    if (!set) return;
    for (const h of set) {
      try {
        h(e.payload.delta);
      } catch {
        /* 单个处理器异常不影响其它 */
      }
    }
  }).then((fn) => fn);
  return unlistenPromise.then(() => undefined);
}

/**
 * 确保全局监听已就绪。调用方在 invoke 之前 await 一次，就不会丢开头的 chunk。
 * 幂等：只注册一次，后续调用直接拿到已 resolve 的 promise。
 */
export function ensureAiChunkListener(): Promise<void> {
  return ensureListener();
}

/** 注册某个动作的流式监听；返回取消函数（执行结束/组件卸载时调用） */
export function onAiChunk(actionId: string, handler: DeltaHandler): () => void {
  void ensureListener();
  // 同一 actionId **只保留最新一个** handler。
  //
  // 原先是 Set 累加，而 emit 的 payload 没有单次调用 id——快捷区与变换枢纽各跑一份
  // ai-translate 时，两张卡片会各自收到**两路混合**的 delta，显示出不属于自己的文字。
  // 只留最新一个之后：新卡正常打字机，旧卡没有预览但**仍然拿到正确的最终结果**
  // （最终文本来自 ai_run 返回值）。“少一个预览”比“显示错内容”好。
  //
  // 彻底分流需要在协议里加 per-call id（Rust emit + ai_run 参数 + 两个调用方），
  // 为一个完成即自愈的预览问题动 6 个文件的接口不划算。
  const set = new Set<DeltaHandler>([handler]);
  handlers.set(actionId, set);
  let off = false;
  return () => {
    if (off) return;
    off = true;
    const s = handlers.get(actionId);
    if (s) {
      s.delete(handler);
      if (s.size === 0) handlers.delete(actionId);
    }
  };
}
