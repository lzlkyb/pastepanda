/**
 * rcFileStore — 远程电脑 · 文件传输的单例状态层（G6，B4）。
 *
 * 为什么要 store 而不是 hook 里自己 listen：文件状态要被**四处**同时看到
 * ——主窗常驻横幅（人不在工作台也得看得见，规则 15）、会话底栏、工作台被控
 * 视图、以及设备卡片拉起的独立面板。每个挂载点各装一个 `rc-file-state`
 * 监听，就是四份重复状态 + 四次 JSON 解析，正是 `rcStore` 当初要解决的那个问题。
 *
 * 与 `rcStore` 的差别：这里**没有轮询**。文件状态由后端在变化时主动推
 * （≤10Hz 节流，见 `file_state::EMIT_MIN_INTERVAL_MS`），首帧才取一次快照。
 * 所以 acquire 只负责「装监听 + 取首帧」，不排定时器。
 *
 * 速率估算（`rates`）也放在这里：它的输入就是快照序列，喂给一个 tracker 即可；
 * 放在 hook 里会随挂载点数量变成多份互相打架的估算。
 */
import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  rcFileCancel,
  rcFileClearFinished,
  rcFilePull,
  rcFileRespond,
  rcFileSend,
  rcFileSnapshot,
  type RcFileSnapshot,
} from "@/lib/api/rcFile";
import { RateTracker, parseFileSnapshot } from "@/lib/rcFile";

const EMPTY: RcFileSnapshot = { asks: [], tasks: [] };

interface RcFileState {
  snapshot: RcFileSnapshot;
  /** 任务 id → 字节/秒（EMA）。查不到 = 0（还没量到，不编造）。 */
  rates: Record<string, number>;
  busy: boolean;
  error: string | null;
  subscribers: number;

  acquire: () => void;
  release: () => void;
  /** 拉一次完整快照（挂载首帧、或事件丢包后的兜底）。 */
  refresh: () => Promise<void>;
  /** 事件载荷 / 命令返回共用的入口。 */
  applySnapshot: (raw: unknown) => void;

  send: (peer: string, paths: string[]) => Promise<boolean>;
  pull: (peer: string, dir: string) => Promise<boolean>;
  respond: (askId: string, acceptDir: string | null) => Promise<boolean>;
  cancel: (taskId: string) => Promise<void>;
  clearFinished: () => Promise<void>;
  /** 会话/设备切换时清掉当前视图的残留（可选，默认不清——任务会自己走完）。 */
  resetView: () => void;
}

let unlisteners: UnlistenFn[] = [];
let listenerStarting = false;
/** 单例 tracker：速率估算必须只有一份，否则多挂载点各算各的。 */
const tracker = new RateTracker();

async function ensureListener(get: () => RcFileState) {
  if (unlisteners.length > 0 || listenerStarting) return;
  listenerStarting = true;
  try {
    const off = await listen("rc-file-state", (ev) => {
      get().applySnapshot(ev.payload);
    });
    unlisteners = [off];
  } catch {
    /* 非 Tauri 环境：忽略 */
  } finally {
    listenerStarting = false;
  }
}

export const useRcFileStore = create<RcFileState>((set, get) => ({
  snapshot: EMPTY,
  rates: {},
  busy: false,
  error: null,
  subscribers: 0,

  acquire: () => {
    const n = get().subscribers + 1;
    set({ subscribers: n });
    if (n === 1) {
      // 监听先于首帧：反过来的话，装监听之前到达的变化会丢（那段时间 UI 是瞎的）
      void ensureListener(get).then(() => get().refresh());
    }
  },
  release: () => {
    set({ subscribers: Math.max(0, get().subscribers - 1) });
  },

  refresh: async () => {
    try {
      get().applySnapshot(await rcFileSnapshot());
      set({ error: null });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  applySnapshot: (raw) => {
    const snap = parseFileSnapshot(raw);
    const rateOf = tracker.feed(snap.tasks, Date.now());
    const rates: Record<string, number> = {};
    for (const t of snap.tasks) rates[t.id] = rateOf(t);
    set({ snapshot: snap, rates });
  },

  send: async (peer, paths) => {
    set({ busy: true, error: null });
    try {
      await rcFileSend(peer, paths);
      return true;
    } catch (e) {
      set({ error: String(e) });
      return false;
    } finally {
      set({ busy: false });
    }
  },

  pull: async (peer, dir) => {
    set({ busy: true, error: null });
    try {
      await rcFilePull(peer, dir);
      return true;
    } catch (e) {
      set({ error: String(e) });
      return false;
    } finally {
      set({ busy: false });
    }
  },

  respond: async (askId, acceptDir) => {
    set({ busy: true, error: null });
    try {
      await rcFileRespond(askId, acceptDir);
      return true;
    } catch (e) {
      // 回不上响应 = 这次请求会走到超时，用户必须知道（别静默）
      set({ error: String(e) });
      return false;
    } finally {
      set({ busy: false });
    }
  },

  cancel: async (taskId) => {
    try {
      await rcFileCancel(taskId);
    } catch (e) {
      set({ error: String(e) });
    }
  },

  clearFinished: async () => {
    try {
      await rcFileClearFinished();
      // 立刻本地清一遍，不等下一次事件（清完可能就没有下一次事件了）
      const st = get().snapshot;
      get().applySnapshot({
        asks: st.asks,
        tasks: st.tasks.filter(
          (t) =>
            t.state === "awaiting" || t.state === "transferring",
        ),
      });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  resetView: () => {
    tracker.reset();
    set({ snapshot: EMPTY, rates: {} });
  },
}));
