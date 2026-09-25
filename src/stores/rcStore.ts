/**
 * rcStore — 远程电脑状态层（**每 WebView 单例**）。
 *
 * 取代原先散落在多个 `useRc` 实例里的「重复状态 + 重复定时器」：
 *
 * 1. 同一 WebView 内只有一个 `rc_status` 轮询定时器，由订阅计数（acquire/release）
 *    控制启停。三处 useRc（RcOverlay / RemoteComputerDialog / RcSection）各自挂载时
 *    acquire、卸载时 release；只要还有任一实例活着（例如对话框关了但 Overlay 还挂着），
 *    轮询就不中断。busy / error 因此不再有双源，任意实例上的操作失败都会浮到同一份状态上。
 *
 *    ⚠️ P1-9 已知限制：**不是进程级单例**。主窗 / 工作台 / 托盘弹窗等多窗口各有自己的
 *    JS 模块实例，会各自持有一份 timer/listener——同时挂载时就双轮询。缓解：
 *    隐藏窗口走 `setVisible(false)` → HIDDEN_MS 降频路径（只探 rc_status）。
 *    跨 WebView 去重（BroadcastChannel / 主窗优先）成本高于收益，本版不做。
 *
 * 2. 窗口可见时沿用原节奏：有会话/敲门 2s、空闲 5s；窗口「隐藏时不停止轮询」，
 *    而是降到 15s 且「只调 rc_status」——隐藏期也可能有入站申请到达，必须被探到
 *    （规则 #8：不可见不空转，但彻底停轮询会让 RcOverlay「拉起窗口」逻辑变成死代码，
 *    所以降频而非停）。
 *
 * 3. 真正的状态活在 app 级单例里。原 useRc 的 `alive` 守卫不再需要：组件卸载不会让
 *    store 消失，setState 永远安全，也就没有「卸载后 setState」的 React 告警。
 *
 * ── 拆分说明 ──
 * 本文件现仅承载 zustand `create` 与对外 `useRcStore` 导出（门面）。轮询引擎与事件订阅
 * 已拆到 `./rcStoreEngine`，`RcState` 形状定义拆到 `./rcStoreTypes`。所有
 * `from "@/stores/rcStore"` 的引用继续原样工作。拆分只搬代码、不改行为。
 */
import { create } from "zustand";
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
} from "@/lib/api/rc";
import type { RcReachability, RcState } from "./rcStoreTypes";
import { clearTimer, ensureListener, scheduleNext } from "./rcStoreEngine";

export const useRcStore = create<RcState>((set, get) => {
  // P1-11：请求代数——发起 ++seq，落地时非当前丢弃，避免慢响应覆盖新状态
  let refreshSeq = 0;
  let targetsSeq = 0;
  const probeSeq = new Map<string, number>();
  // P3-3：错误写入代数——成功路径只在「没有别的 run 中途写过错误」时才清
  let errWrite = 0;
  // 🔴 再审计（P3-3 修补，2026-09-25）：「写错误 + 递增 errWrite」的唯一出口。
  // 原先 refresh 回显 outbound_error 时只 set 不递增，run 的成功路径按
  // 「errWrite 没动 = 本 run 期间无人写过错误」清场——并发窗口里把刚被
  // refresh 浮出的错误抹掉，下一轮轮询再回显，表现为错误条闪断。
  // 凡是把文案写进 error 的路径（run 失败 / refresh 回显）都必须走这里。
  const writeError = (msg: string) => {
    errWrite += 1;
    set({ error: msg });
  };

  return {
  status: null,
  targets: [],
  targetsLoaded: false,
  targetsError: null,
  reachability: {},
  identity: null,
  busy: false,
  busyCount: 0,
  lastClearedError: null,
  lastClearedAt: 0,
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
    const gen = ++refreshSeq;
    try {
      const s = await rcStatus();
      if (gen !== refreshSeq) return; // 已有更新的请求在途/落地，这份旧响应作废
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
      // B1 + P3-4：与用户刚清掉的是**同一串**、且还在短窗口内 → 不回显，
      // 窗口过后同串算真实新错误，重新弹。
      // 🔴 P1-4：后端槽位改带归因结构（peer/session_id/error），store 的 error 仍存文案；
      // 归因暂不参与展示（错误条是全局位），要挂回设备行时从这里取。
      const now = Date.now();
      const outboundErr = s.outbound_error?.error ?? null;
      const ignoredClear =
        outboundErr != null &&
        outboundErr === get().lastClearedError &&
        now - get().lastClearedAt < 2000;
      if (outboundErr && !ignoredClear) {
        // 🔴 P3-3 修补：走 writeError（递增 errWrite），run 的成功路径才不会
        // 把这条刚浮出的回显错误当「无人写过」清掉。
        writeError(outboundErr);
      }
    } catch (e) {
      if (gen !== refreshSeq) return;
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
    const gen = ++targetsSeq;
    try {
      const t = await rcTargets();
      if (gen !== targetsSeq) return null;
      set({ targets: t, targetsLoaded: true, targetsError: null });
      return t;
    } catch (e) {
      if (gen !== targetsSeq) return null;
      set({ targetsError: e instanceof Error ? e.message : String(e) });
      return null;
    }
  },
  probeTargets: async (only?: string[]) => {
    const st = get();
    if (!st.status?.running) return;
    const wanted = new Set(only ?? []);
    const ids = st.targets
      .filter((t) => wanted.has(t.node_id) && t.source === "rc")
      .map((t) => t.node_id);
    if (ids.length === 0) return;
    const generations = new Map(ids.map((id) => {
      const gen = (probeSeq.get(id) ?? 0) + 1;
      probeSeq.set(id, gen);
      return [id, gen] as const;
    }));
    const commit = (stateFor: (id: string) => RcReachability) => {
      const current = ids.filter((id) => probeSeq.get(id) === generations.get(id));
      if (current.length === 0) return;
      set((prev) => ({
        reachability: {
          ...prev.reachability,
          ...Object.fromEntries(current.map((id) => [id, stateFor(id)])),
        },
      }));
    };
    commit(() => ({ state: "checking" }));
    try {
      const result = await rcProbeTargets(ids);
      const checkedAt = Date.now();
      commit((id) => ({
        state: result[id] === true ? "reachable" : result[id] === false ? "unreachable" : "error",
        checkedAt,
      }));
    } catch {
      commit(() => ({ state: "error", checkedAt: Date.now() }));
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
    // B1 + P3-4：记下被清的后端串与时刻。异步 rcClearOutboundError 生效前的窗口期里，
    // refresh 轮询会带回同一个 outbound_error——短窗口（2s）内同串不回显；之后同串
    // 视为真实新错误（避免永久误杀）。
    set((st) => ({
      error: null,
      statusError: null,
      lastClearedError: st.error,
      lastClearedAt: Date.now(),
    }));
    void rcClearOutboundError().catch(() => {});
  },

  run: async (fn) => {
    // B4：计数制——并发时后完成者收尾，busy 才归 false
    // P3-3：入口**不**清 error——并发时新操作启动会抹掉别人刚写入的失败
    set((st) => ({ busyCount: st.busyCount + 1, busy: true }));
    const errWriteAtStart = errWrite;
    try {
      await fn();
      await get().refresh();
      await get().refreshTargets();
      // 仅成功路径清；且只有「本 run 期间没人写过错误」才清（避免并发抹错）
      if (errWrite === errWriteAtStart) set({ error: null });
      return true;
    } catch (e) {
      // 🔴 P3-3 修补：走唯一出口 writeError（与 refresh 回显同口径递增）
      writeError(e instanceof Error ? e.message : String(e));
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
  };
});
