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
  rcDeviceAutoAcceptSet,
  rcDeviceTrustSet,
  rcEndSession,
  rcForget,
  rcHistoryClear,
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
  rcProbeTargets,
  rcStartChannel,
  rcStatus,
  rcTargets,
  rcSetQuality,
  rcSetCaptureScope,
  rcUnoGenerate,
  rcUnoRevoke,
  rcUnoPassEnable,
  rcUnoPassDisable,
  rcUnoPassSetWan,
  type RcCapability,
  type RcCaptureScope,
  type RcIdentity,
  type RcInvite,
  type RcInviteCreated,
  type RcPathChanged,
  type RcQuality,
  type RcStatus,
  type RcTargetDevice,
  type RcUnoCreated,
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
  /** B4：并发操作计数——先完成者不得提前解除后到者的禁用 */
  busyCount: number;
  /** B1：用户刚主动清掉的后端错误串——同串在清除生效前被轮询拿回时不回显 */
  lastClearedError: string | null;
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
  /**
   * 被控端：对端刚改了本机推流档位（Q10，kind = "quality" | "codec"）。
   * 对端（连只看会话）能单方面调画质/编码，原来是静默 log——被控者看到
   * 画面变糊/变清却不知原因；由被控横幅展示，用户确认或会话结束清除。
   */
  streamNotice: { kind: string; name: string } | null;
  /**
   * 会话中路径自动切换（relay ↔ 直连，C）。非 null 时由会话视图 toast 一次。
   *
   * iroh 每 60s 会尝试把中继升级成直连——不加提示的话，用户只会看到
   * 「延迟突然从 90ms 掉到 12ms」却不知道为什么。
   */
  pathNotice: RcPathChanged | null;

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
  /** 按需探活：对非 live 设备短超时拨一次，再刷新列表。不空转。 */
  probeTargets: () => Promise<void>;
  refreshIdentity: () => Promise<void>;
  clearError: () => void;
  /** 记下「对端改了画面范围」待展示提示（由 rc-scope-changed 事件驱动）。 */
  setScopeNotice: (scope: string) => void;
  clearScopeNotice: () => void;
  /** 记下「对端改了画质/编码」待展示提示（由 rc-stream-note 事件驱动，Q10）。 */
  setStreamNotice: (n: { kind: string; name: string }) => void;
  clearStreamNotice: () => void;
  /** 记下「换路了」待展示（由 `rc-path-changed` 事件驱动）。 */
  setPathNotice: (p: RcPathChanged) => void;
  clearPathNotice: () => void;

  // 操作封装
  run: (fn: () => Promise<unknown>) => Promise<boolean>;
  setEnabled: (v: boolean) => Promise<boolean>;
  startChannel: () => Promise<boolean>;
  setCapability: (c: RcCapability) => Promise<boolean>;
  setQuality: (q: RcQuality) => Promise<boolean>;
  setCaptureScope: (s: RcCaptureScope) => Promise<boolean>;
  setDeviceAllowed: (id: string, ok: boolean) => Promise<boolean>;
  /** 方案 D：设置「免确认直连」（默认关，逐台；deny 优先级更高）。 */
  setDeviceTrust: (id: string, trusted: boolean) => Promise<boolean>;
  /**
   * 决策 10：设置「自动接收此设备推送的文件」（默认关，逐台）。
   *
   * 🔴 只跳确认条，**不跳门禁**（`gate_inbound` 一律先跑）；只对推送方向生效。
   */
  setDeviceAutoAccept: (id: string, on: boolean) => Promise<boolean>;
  createInvite: (name: string) => Promise<RcInviteCreated>;
  previewInvite: (code: string) => Promise<RcInvite>;
  pair: (code: string) => Promise<boolean>;
  forget: (id: string) => Promise<boolean>;
  approveJoin: (id: string, name: string) => Promise<boolean>;
  denyJoin: (id: string) => Promise<boolean>;
  request: (id: string, cap: RcCapability) => Promise<boolean>;
  /** Q2：带无人值守接入码发起（目标机器可以没人、未配对）。 */
  requestUno: (id: string, code: string, cap: RcCapability) => Promise<boolean>;
  /** Q2 方案 C：带固定密码发起（目标机器可以没人、未配对）。 */
  requestPass: (id: string, pass: string, cap: RcCapability) => Promise<boolean>;
  /** Q2：生成无人值守接入码（被控端）。 */
  unoGenerate: (p: {
    ttlSecs: number;
    unlimited: boolean;
    capability: RcCapability;
    alsoTrust: boolean;
  }) => Promise<RcUnoCreated>;
  /** Q2：撤销全部无人值守接入码。 */
  unoRevoke: () => Promise<boolean>;
  /** Q2 方案 C：开启 / 换固定密码（被控端）。 */
  unoPassEnable: (p: {
    password: string;
    capability: RcCapability;
    allowWan: boolean;
  }) => Promise<boolean>;
  /** Q2 方案 C：一键全局关闭固定密码。 */
  unoPassDisable: () => Promise<boolean>;
  /** Q2 方案 C：只改「允许跨网」开关。 */
  unoPassSetWan: (allow: boolean) => Promise<boolean>;
  cancel: () => Promise<boolean>;
  end: () => Promise<boolean>;
  approve: (id: string) => Promise<boolean>;
  deny: (id: string) => Promise<boolean>;
  /** 清空全部会话历史（设置页「清空记录」）。 */
  clearHistory: () => Promise<boolean>;
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

/** rc-session-changed / rc-scope-changed / rc-path-changed 事件只装一次。 */
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
    // Q10：被控端——对端改了本机画质/编码档。原来是静默 log；画面突然变糊
    // /变清时要能看见原因。收成提示由被控横幅展示，确认或会话结束清除。
    // G3：同理收「对端开关了本机系统声音」（kind=audio，name=on/off）。
    const onStream = await listen<{ kind?: string; name?: string }>("rc-stream-note", (ev) => {
      const kind = ev.payload?.kind;
      const name = ev.payload?.name;
      const known = kind === "quality" || kind === "codec" || kind === "audio";
      if (!known || typeof name !== "string" || !name) return;
      get().setStreamNotice({ kind, name });
    });
    // C：会话中自动换路（relay ↔ 直连）。顺带刷一次状态，让 HUD 立刻显示新档位。
    const onPath = await listen<{ from?: string; to?: string }>("rc-path-changed", (ev) => {
      const from = ev.payload?.from;
      const to = ev.payload?.to;
      if (typeof from !== "string" || typeof to !== "string") return;
      get().setPathNotice({ from, to });
      void get().refresh();
    });
    unlisteners = [onSession, onScope, onStream, onPath];
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
  busyCount: 0,
  lastClearedError: null,
  error: null,
  statusError: null,
  scopeNotice: null,
  streamNotice: null,
  pathNotice: null,
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
        // 换路提示同理：只对当时那个会话有意义，留着会让下一个会话看到过期提示
        pathNotice:
          s.session && prev.status?.session?.id === s.session.id ? prev.pathNotice : null,
        // Q10：改档提示同样只属于当时那个会话
        streamNotice:
          s.session && prev.status?.session?.id === s.session.id ? prev.streamNotice : null,
      }));
      // 非阻塞申请的后台失败：clone 保留在后端，用户 dismiss / 下次发起 / 结束时才清
      // B1：与用户刚清掉的是**同一串**（异步清除还没在后端生效）→ 不回显，
      // 只有新出现的错误串（不同内容）才重新弹。
      if (s.outbound_error && s.outbound_error !== get().lastClearedError) {
        set({ error: s.outbound_error });
      }
    } catch (e) {
      // 状态刷新失败 ≠ 远程申请失败，不能诱导用户重发申请
      set({ statusError: e instanceof Error ? e.message : String(e) });
    }
  },
  setScopeNotice: (scope) => set({ scopeNotice: scope }),
  clearScopeNotice: () => set({ scopeNotice: null }),
  setStreamNotice: (n) => set({ streamNotice: n }),
  clearStreamNotice: () => set({ streamNotice: null }),
  setPathNotice: (p) => set({ pathNotice: p }),
  clearPathNotice: () => set({ pathNotice: null }),
  refreshTargets: async () => {
    try {
      const t = await rcTargets();
      set({ targets: t });
    } catch {
      /* 列表失败不打断主状态 */
    }
  },
  probeTargets: async () => {
    const st = get();
    // live 的不用探；通道没起探了也是 channel_down
    if (!st.status?.running) {
      await get().refreshTargets();
      return;
    }
    const ids = st.targets
      .filter((t) => t.presence !== "live")
      .map((t) => t.node_id);
    if (ids.length > 0) {
      try {
        await rcProbeTargets(ids);
      } catch {
        /* 探活失败不打断列表；后面 refreshTargets 仍展示现状态 */
      }
    }
    await get().refreshTargets();
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
    // B1：记下被清的后端串。异步 rcClearOutboundError 生效前的窗口期里，
    // refresh 轮询会带回同一个 outbound_error——同串不回显（见 refresh）。
    set((st) => ({
      error: null,
      statusError: null,
      lastClearedError: st.error,
    }));
    void rcClearOutboundError().catch(() => {});
  },

  run: async (fn) => {
    // B4：计数制——并发时后完成者收尾，busy 才归 false
    set((st) => ({ busyCount: st.busyCount + 1, busy: true, error: null }));
    try {
      await fn();
      await get().refresh();
      await get().refreshTargets();
      return true;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return false;
    } finally {
      set((st) => {
        const n = Math.max(0, st.busyCount - 1);
        return { busyCount: n, busy: n > 0 };
      });
    }
  },
  setEnabled: (v) => get().run(() => rcSetEnabled(v)),
  startChannel: () => get().run(() => rcStartChannel()),
  setCapability: (c) => get().run(() => rcSetCapability(c)),
  setQuality: (q) => get().run(() => rcSetQuality(q)),
  setCaptureScope: (s) => get().run(() => rcSetCaptureScope(s)),
  setDeviceAllowed: (id, ok) => get().run(() => rcSetDeviceAllowed(id, ok)),
  setDeviceTrust: (id, trusted) => get().run(() => rcDeviceTrustSet(id, trusted)),
  setDeviceAutoAccept: (id, on) => get().run(() => rcDeviceAutoAcceptSet(id, on)),
  // 以下两个不走 run：直接返回 Promise，调用方自己处理 loading / 错误
  createInvite: (name) => rcInviteCreate(name),
  previewInvite: (code) => rcInvitePreview(code),
  pair: (code) => get().run(() => rcPair(code)),
  forget: (id) => get().run(() => rcForget(id)),
  approveJoin: (id, name) => get().run(() => rcJoinApprove(id, name)),
  denyJoin: (id) => get().run(() => rcJoinDeny(id)),
  request: (id, cap) => get().run(() => rcRequestSession(id, cap)),
  requestUno: (id, code, cap) => get().run(() => rcRequestSession(id, cap, code)),
  requestPass: (id, pass, cap) => get().run(() => rcRequestSession(id, cap, undefined, pass)),
  unoGenerate: (p) =>
    rcUnoGenerate({
      ttlSecs: p.ttlSecs,
      unlimited: p.unlimited,
      capability: p.capability,
      alsoTrust: p.alsoTrust,
    }),
  unoRevoke: () => get().run(() => rcUnoRevoke()),
  unoPassEnable: (p) =>
    get().run(() =>
      rcUnoPassEnable({ password: p.password, capability: p.capability, allowWan: p.allowWan }),
    ),
  unoPassDisable: () => get().run(() => rcUnoPassDisable()),
  unoPassSetWan: (allow) => get().run(() => rcUnoPassSetWan(allow)),
  cancel: () => get().run(() => rcCancelRequest()),
  end: () => get().run(() => rcEndSession()),
  approve: (id) => get().run(() => rcApproveInbound(id)),
  deny: (id) => get().run(() => rcDenyInbound(id)),
  clearHistory: () => get().run(() => rcHistoryClear()),
}));
