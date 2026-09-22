/**
 * rcStore 的轮询引擎与事件订阅（从 `src/stores/rcStore.ts` 拆分而来，仅搬代码、
 * 不改行为）。原始 `rcStore.ts` 现为 `useRcStore` 的 re-export 门面，所有
 * `from "@/stores/rcStore"` 的引用继续原样工作。
 */
import { listen } from "@tauri-apps/api/event";
import type { RcState } from "./rcStoreTypes";

const IDLE_MS = 5000;
const ACTIVE_MS = 2000;
/** 窗口隐藏时的降频周期：只探 rc_status，避免漏掉入站申请。 */
const HIDDEN_MS = 15000;

// P1-9：**每 WebView 单例**的定时器句柄（模块级，同一 WebView 内只此一个）。
// ⚠️ 不是进程级单例：主窗 / 工作台 / 托盘弹窗等多窗口各有自己的 JS 模块实例，
// 会各自持有一份 timer/listener，同时挂载时就双轮询（已知限制，见 rcStore 头注释）。
let timer: ReturnType<typeof setTimeout> | null = null;
// rc-session-changed 事件监听只装一次（同样只限本 WebView）
let unlisteners: Array<() => void> = [];
let listenerStarting = false;

function isActive(s: RcState["status"]): boolean {
  if (!s) return false;
  return (
    !!s.session ||
    (s.pending?.length ?? 0) > 0 ||
    (s.joins?.length ?? 0) > 0
  );
}

function clearTimer() {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

/**
 * 安排下一次轮询。周期取决于「可见性 + 是否活跃」：
 * - 隐藏：HIDDEN_MS，且本轮 tick 只调 rc_status（scheduleNext 里固定只 refresh）。
 * - 可见：活跃 ACTIVE_MS，否则 IDLE_MS。
 * 用递归 setTimeout 而非 setInterval，每次 tick 后重新评估周期，省掉原 effect 重订阅的抖动。
 */
function scheduleNext(get: () => RcState) {
  const st = get();
  if (st.subscribers <= 0) {
    clearTimer();
    return;
  }
  const period = st.visible
    ? isActive(st.status)
      ? ACTIVE_MS
      : IDLE_MS
    : HIDDEN_MS;
  clearTimer();
  timer = setTimeout(() => {
    void get()
      .refresh()
      .finally(() => scheduleNext(get));
  }, period);
}

/**
 * rc-session-changed / rc-scope-changed / rc-path-changed 事件只装一次。
 *
 * P1-7：任一 `listen` 失败必须回滚**已装上**的那几路——否则它们泄漏在后台，
 * 而 `unlisteners` 仍空，下次 `ensureListener` 再装一遍 → 重复注册。
 */
async function ensureListener(get: () => RcState) {
  if (unlisteners.length > 0 || listenerStarting) return;
  listenerStarting = true;
  // 先收进局部数组，全部成功才写入模块级 unlisteners
  const collected: Array<() => void> = [];
  try {
    collected.push(
      await listen("rc-session-changed", () => {
        void get().refresh();
      }),
    );
    // B3：被控端——对端（哪怕是「只看」会话）改了本机画面范围。
    // 后端原来只 log，被控者毫无察觉；这里收成一条待展示的提示，
    // 由被控横幅显示，直到用户确认或会话结束。
    collected.push(
      await listen<{ scope?: string }>("rc-scope-changed", (ev) => {
        const scope = ev.payload?.scope;
        if (typeof scope !== "string" || !scope) return;
        get().setScopeNotice(scope);
      }),
    );
    // Q10：被控端——对端改了本机画质/编码档。原来是静默 log；画面突然变糊
    // /变清时要能看见原因。收成提示由被控横幅展示，确认或会话结束清除。
    // G3：同理收「对端开关了本机系统声音」（kind=audio，name=on/off）。
    collected.push(
      await listen<{ kind?: string; name?: string }>("rc-stream-note", (ev) => {
        const kind = ev.payload?.kind;
        const name = ev.payload?.name;
        const known = kind === "quality" || kind === "codec" || kind === "audio";
        if (!known || typeof name !== "string" || !name) return;
        get().setStreamNotice({ kind, name });
      }),
    );
    // C：会话中自动换路（relay ↔ 直连）。顺带刷一次状态，让 HUD 立刻显示新档位。
    collected.push(
      await listen<{ from?: string; to?: string }>("rc-path-changed", (ev) => {
        const from = ev.payload?.from;
        const to = ev.payload?.to;
        if (typeof from !== "string" || typeof to !== "string") return;
        get().setPathNotice({ from, to });
        void get().refresh();
      }),
    );
    unlisteners = collected;
  } catch {
    // 半失败：把已经装上的全部卸掉，下次 ensureListener 可干净重试
    for (const off of collected) {
      try {
        off();
      } catch {
        /* 卸载失败不影响回滚 */
      }
    }
  } finally {
    listenerStarting = false;
  }
}

export { scheduleNext, ensureListener, clearTimer };
