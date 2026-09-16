/**
 * rcStore — 远程电脑单例状态层。
 *
 * 取代原先散落在多个 `useRc` 实例里的「重复状态 + 重复定时器」：
 *
 * 1. 全进程只有一个 `rc_status` 轮询定时器，由订阅计数（acquire/release）控制启停。
 *    三处 useRc（RcOverlay / RemoteComputerDialog / RcSection）各自挂载时 acquire、
 *    卸载时 release；只要还有任一实例活着（例如对话框关了但 Overlay 还挂着），轮询就不中断。
 *    busy / error 因此不再有双源，任意实例上的操作失败都会浮到同一份状态上。
 *
 * 2. 窗口可见时沿用原节奏：有会话/敲门 2s、空闲 5s；窗口「隐藏时不停止轮询」，
 *    而是降到 15s 且「只调 rc_status」——隐藏期也可能有入站申请到达，必须被探到
 *    （规则 #8：不可见不空转，但彻底停轮询会让 RcOverlay「拉起窗口」逻辑变成死代码，
 *    所以降频而非停）。
 *
 * 3. 真正的状态活在 app 级单例里。原 useRc 的 `alive` 守卫不再需要：组件卸载不会让
 *    store 消失，setState 永远安全，也就没有「卸载后 setState」的 React 告警。
 */
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  rcApproveInbound,
  rcCancelRequest,
  rcClearOutboundError,
  rcDenyInbound,
  rcEndSession,
  rcForget,
  rcIdentity,
  rcInviteCreate,
  rcInvitePreview,
  rcJoinApprove,
  rcJoinDeny,
  rcPair,
  rcRequestSession,
  rcSetCapability,
  rcSetDeviceAllowed,
  rcSetEnabled,
  rcStartChannel,
  rcStatus,
  rcTargets,
  rcSetQuality,
  rcSetCaptureScope,
  type RcCapability,
  type RcCaptureScope,
  type RcIdentity,
  type RcInvite,
  type RcInviteCreated,
  type RcQuality,
  type RcStatus,
  type RcTargetDevice,
} from "@/lib/api/rc";

const IDLE_MS = 5000;
const ACTIVE_MS = 2000;
/** 窗口隐藏时的降频周期：只探 rc_status，避免漏掉入站申请。 */
const HIDDEN_MS = 15000;

// 全进程唯一的定时器句柄（模块级，保证只此一个）
let timer: ReturnType<typeof setTimeout> | null = null;
// rc-session-changed 事件监听只装一次
let unlisteners: Array<() => void> = [];
let listenerStarting = false;

function isActive(s: RcStatus | null): boolean {
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

interface RcState {
  status: RcStatus | null;
  targets: RcTargetDevice[];
  identity: RcIdentity | null;
  busy: boolean;
  /** 操作失败（可重试原操作） */
  error: string | null;
  /** 仅状态刷新失败（重试只应 refresh，不算操作失败） */
  statusError: string | null;
  /**
   * 被控端：对端刚改了本机画面范围（B3）。
   * 非 null 时被控横幅要显示出来——观察者能改被观察者的采集范围，
   * 被观察者必须看得见，否则等于悄悄把画面切到别处。
   */
  scopeNotice: string | null;

  // 轮询引擎
  subscribers: number;
  visible: boolean;

  // 生命周期
  acquire: () => void;
  release: () => void;
  setVisible: (v: boolean) => void;

  // 数据刷新
  refresh: () => Promise<void>;
  refreshTargets: () => Promise<void>;
  refreshIdentity: () => Promise<void>;
  clearError: () => void;
  /** 记下「对端改了画面范围」待展示提示（由 rc-scope-changed 事件驱动）。 */
  setScopeNotice: (scope: string) => void;
  clearScopeNotice: () => void;

  // 操作封装
  run: (fn: () => Promise<unknown>) => Promise<boolean>;
  setEnabled: (v: boolean) => Promise<boolean>;
  startChannel: () => Promise<boolean>;
  setCapability: (c: RcCapability) => Promise<boolean>;
  setQuality: (q: RcQuality) => Promise<boolean>;
  setCaptureScope: (s: RcCaptureScope) => Promise<boolean>;
  setDeviceAllowed: (id: string, ok: boolean) => Promise<boolean>;
  createInvite: (name: string) => Promise<RcInviteCreated>;
  previewInvite: (code: string) => Promise<RcInvite>;
  pair: (code: string) => Promise<boolean>;
  forget: (id: string) => Promise<boolean>;
  approveJoin: (id: string, name: string) => Promise<boolean>;
  denyJoin: (id: string) => Promise<boolean>;
  request: (id: string, cap: RcCapability) => Promise<boolean>;
  cancel: () => Promise<boolean>;
  end: () => Promise<boolean>;
  approve: (id: string) => Promise<boolean>;
  deny: (id: string) => Promise<boolean>;
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

/** rc-session-changed / rc-scope-changed 事件只装一次。 */
async function ensureListener(get: () => RcState) {
  if (unlisteners.length > 0 || listenerStarting) return;
  listenerStarting = true;
  try {
    const onSession = await listen("rc-session-changed", () => {
      void get().refresh();
    });
    // B3：被控端——对端（哪怕是「只看」会话）改了本机画面范围。
    // 后端原来只 log，被控者毫无察觉；这里收成一条待展示的提示，
    // 由被控横幅显示，直到用户确认或会话结束。
    const onScope = await listen<{ scope?: string }>("rc-scope-changed", (ev) => {
      const scope = ev.payload?.scope;
      if (typeof scope !== "string" || !scope) return;
      get().setScopeNotice(scope);
    });
    unlisteners = [onSession, onScope];
  } catch {
    /* 非 Tauri 环境：忽略 */
  } finally {
    listenerStarting = false;
  }
}

export const useRcStore = create<RcState>((set, get) => ({
  status: null,
  targets: [],
  identity: null,
  busy: false,
  error: null,
  statusError: null,
  scopeNotice: null,
  subscribers: 0,
  visible: true,

  acquire: () => {
    const n = get().subscribers + 1;
    set({ subscribers: n });
    if (n === 1) {
      // 首个订阅者：立刻探一次 + 起定时器 + 装事件监听
      void get().refresh();
      void ensureListener(get);
      scheduleNext(get);
    }
  },
  release: () => {
    const n = Math.max(0, get().subscribers - 1);
    set({ subscribers: n });
    if (n === 0) clearTimer();
  },
  setVisible: (v) => {
    if (get().visible === v) return;
    set({ visible: v });
    scheduleNext(get); // 重新按可见性挑周期（隐藏降频 / 可见恢复）
  },

  refresh: async () => {
    try {
      const s = await rcStatus();
      set((prev) => ({
        status: s,
        statusError: null,
        // B3：会话结束、或换到了另一个会话 → 收掉「对方改了画面范围」的提示
        // （它只对当时那个会话有意义，留着会让下一个会话看到过期提示）
        scopeNotice:
          s.session && prev.status?.session?.id === s.session.id ? prev.scopeNotice : null,
      }));
      // 非阻塞申请的后台失败：clone 保留在后端，用户 dismiss / 下次发起 / 结束时才清
      if (s.outbound_error) set({ error: s.outbound_error });
    } catch (e) {
      // 状态刷新失败 ≠ 远程申请失败，不能诱导用户重发申请
      set({ statusError: e instanceof Error ? e.message : String(e) });
    }
  },
  setScopeNotice: (scope) => set({ scopeNotice: scope }),
  clearScopeNotice: () => set({ scopeNotice: null }),
  refreshTargets: async () => {
    try {
      const t = await rcTargets();
      set({ targets: t });
    } catch {
      /* 列表失败不打断主状态 */
    }
  },
  refreshIdentity: async () => {
    try {
      const id = await rcIdentity();
      set({ identity: id });
    } catch {
      /* 指纹读失败在设置面板另有提示 */
    }
  },
  clearError: () => {
    set({ error: null, statusError: null });
    void rcClearOutboundError().catch(() => {});
  },

  run: async (fn) => {
    set({ busy: true, error: null });
    try {
      await fn();
      await get().refresh();
      await get().refreshTargets();
      return true;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return false;
    } finally {
      set({ busy: false });
    }
  },
  setEnabled: (v) => get().run(() => rcSetEnabled(v)),
  startChannel: () => get().run(() => rcStartChannel()),
  setCapability: (c) => get().run(() => rcSetCapability(c)),
  setQuality: (q) => get().run(() => rcSetQuality(q)),
  setCaptureScope: (s) => get().run(() => rcSetCaptureScope(s)),
  setDeviceAllowed: (id, ok) => get().run(() => rcSetDeviceAllowed(id, ok)),
  // 以下两个不走 run：直接返回 Promise，调用方自己处理 loading / 错误
  createInvite: (name) => rcInviteCreate(name),
  previewInvite: (code) => rcInvitePreview(code),
  pair: (code) => get().run(() => rcPair(code)),
  forget: (id) => get().run(() => rcForget(id)),
  approveJoin: (id, name) => get().run(() => rcJoinApprove(id, name)),
  denyJoin: (id) => get().run(() => rcJoinDeny(id)),
  request: (id, cap) => get().run(() => rcRequestSession(id, cap)),
  cancel: () => get().run(() => rcCancelRequest()),
  end: () => get().run(() => rcEndSession()),
  approve: (id) => get().run(() => rcApproveInbound(id)),
  deny: (id) => get().run(() => rcDenyInbound(id)),
}));
