/**
 * rcAdhoc — 「一次性协助」（方案甲）用后即忘的**唯一判据**（纯函数，可单测）。
 *
 * # 要解决的问题
 *
 * 「让别人帮我」/「帮别人连一次」在协议层与「长期配对」走的是同一条路：
 * `rc_pair` / `rc_join_approve` 都会往 `rc_devices` 写一条**永久**设备。
 * 于是「只帮这一次」用完以后，双方列表里各躺一条再也不会用的设备
 * —— 这正是设计稿要消掉的残留（`design/远程电脑-一次性协助-方案C-设计稿.html` §五）。
 *
 * 遗忘动作本身是现成的（`rc_forget`），难的是「该忘谁」。两侧的已知条件不同：
 *
 * | 侧 | 什么时候知道对方 node_id |
 * |---|---|
 * | 协助方（粘码那侧） | 粘贴时就有（`previewInvite` 返回 `node_id`） |
 * | 被协助方（出码那侧） | **事后才知道**——对方敲门、我点「允许」之后 |
 *
 * # 为什么被协助方不挂在「批准配对」上
 *
 * `approveJoin` 有**两个**调用点（主窗常驻横幅 `RcOverlay` / 设置页 `RcSection`）。
 * 挂上去就要两处都改，漏一处就是「这个入口进来的一次性协助会残留」——
 * 而漏掉时界面完全正常，只有下次打开设备列表才发现多了一台。
 * 所以被协助方改用一个不依赖调用点的信号：**武装（arm）之后出现的第一个会话**
 * 就是这次一次性协助的对象。无论谁批准、从哪个窗口批准，都会经过 `rc_status.session`。
 *
 * # 为什么状态要落 localStorage
 *
 * 出码与真正连上之间隔着「用户去 IM 发码、对方粘贴」——期间用户完全可能关掉
 * 工作台窗口（甚至关掉整个面板）。状态只存内存的话，窗口一关这条一次性协助就
 * 再也不会被遗忘，等于承诺了「会话结束即清理」却没做到。
 * 主窗口的 hook 常驻，会接着把它清掉。
 *
 * 但**不持久 `live`**：它只是「这个 peer 真的连上过」的进程内证据，
 * 重开后若会话还在，`stepAdhoc` 会重新把它标上。
 *
 * # arm 只认「出码之后新出现的设备」（baseline）
 *
 * 光有 arm 是不够的：用户开了「让别人帮我」又改主意、把窗口一关，arm 还会挂
 * 30 分钟。这期间他那台**长期配对**的笔记本连过来，就会被误认成一次性协助，
 * 会话一结束 `rc_forget` 把长期配对删了——代价远比残留一条设备行大。
 *
 * 所以 `armAdhoc` 同时记下**出码那一刻已配对的 node_id**（baseline），
 * 只有不在 baseline 里的 peer 才允许被认领。「让别人帮我」的语义本来就是
 * 「来的是个新人」，这一条把语义直接写成了判据。
 *
 * # arm 的寿命与邀请码对齐
 *
 * 邀请门是 `RC_TTL_SECS`（30 分钟，见 `sync/invite.rs`）。过了这个窗口码本身就
 * 失效了，那次 arm 不可能再对应任何真实会话 ⇒ 必须过期作废，否则用户几小时后
 * 随手帮别人一次，会被误判成「一次性」而把刚配好的设备删掉。
 */
import type { RcSession } from "@/lib/api/rc";
import { sessionMode } from "@/lib/rcWorkbench";

/** arm 的有效期，与邀请门同宽（`invite::RC_TTL_SECS` = 30 分钟）。 */
export const ADHOC_ARM_TTL_MS = 30 * 60 * 1000;

const LS_KEY = "rc_adhoc";

export interface AdhocState {
  /** 被协助方「武装」的时刻（ms）。0 = 未武装。 */
  armedAt: number;
  /** 武装那一刻**已经配对**的设备——它们不是这次要帮自己的人。落盘。 */
  baseline: string[];
  /** 本次一次性协助涉及的设备（这些是要被遗忘的）。落盘。 */
  peers: string[];
  /** 进程内证据：这些 peer 真的进过会话。**不落盘**。 */
  live: string[];
}

const EMPTY: AdhocState = { armedAt: 0, baseline: [], peers: [], live: [] };

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((p): p is string => typeof p === "string" && !!p) : [];

function sanitize(v: unknown): AdhocState {
  if (!v || typeof v !== "object") return { ...EMPTY };
  const o = v as Partial<AdhocState>;
  const armedAt = typeof o.armedAt === "number" && Number.isFinite(o.armedAt) ? o.armedAt : 0;
  return { armedAt, baseline: strList(o.baseline), peers: strList(o.peers), live: [] };
}

/** 读盘。解析失败/隐私模式一律回落空状态——遗留清理读不到不该让调用方炸。 */
export function loadAdhoc(): AdhocState {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? sanitize(JSON.parse(raw)) : { ...EMPTY };
  } catch {
    return { ...EMPTY };
  }
}

/** 落盘（只存 `armedAt` / `baseline` / `peers`；`live` 是进程内证据）。 */
export function saveAdhoc(s: AdhocState): void {
  try {
    if (!s.armedAt && !s.peers.length) {
      localStorage.removeItem(LS_KEY);
      return;
    }
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ armedAt: s.armedAt, baseline: s.baseline, peers: s.peers }),
    );
  } catch {
    /* 存不下只影响跨窗口清理，不报错 */
  }
}

/**
 * 被协助方：出码即武装——「出码之后**新出现**的会话」才是这次一次性协助。
 *
 * @param baseline 出码那一刻已配对的 node_id。传进来是为了排除「用户开了这个框
 *   又关掉、结果自己那台长期设备连过来被误删」——见文件头。
 */
export function armAdhoc(now: number, baseline: string[] = [], s: AdhocState = loadAdhoc()): AdhocState {
  const next = { ...s, armedAt: now, baseline: [...baseline] };
  saveAdhoc(next);
  return next;
}

/** 协助方：粘贴时就知道对方是谁，直接点名。 */
export function markAdhocPeer(peer: string, s: AdhocState = loadAdhoc()): AdhocState {
  if (!peer || s.peers.includes(peer)) return s;
  const next = { ...s, peers: [...s.peers, peer] };
  saveAdhoc(next);
  return next;
}

/** 本次一次性协助涉及的设备一律撤销（用户取消该次协助时用）。 */
export function clearAdhocPeers(s: AdhocState = loadAdhoc()): AdhocState {
  const next = { ...s, peers: [], live: [] };
  saveAdhoc(next);
  return next;
}

export interface AdhocStep {
  state: AdhocState;
  /** 这次该真去 `rc_forget` 的设备。 */
  forget: string[];
}

/**
 * 每来一次 `rc_status` 就喂一遍：进会话时登记，回到空闲时结账。
 *
 * @param session 当前会话（`null` / `phase==="idle"` 都算空闲）
 * @param now     现在（ms）
 */
export function stepAdhoc(s: AdhocState, session: RcSession | null, now: number): AdhocStep {
  // arm 过期作废：码本身早失效了，再把它当成「一次性」只会误删刚配好的设备。
  const armed = s.armedAt > 0 && now - s.armedAt <= ADHOC_ARM_TTL_MS;

  const mode = sessionMode(session);
  if (mode !== "idle" && session) {
    const peer = session.peer;
    // baseline 里的设备是「出码前就配好的」，不是这次要帮自己的人。
    const fresh = !s.baseline.includes(peer);
    const addPeer = armed && fresh && !s.peers.includes(peer);
    const peers = addPeer ? [...s.peers, peer] : s.peers;
    const live = peers.includes(peer) && !s.live.includes(peer) ? [...s.live, peer] : s.live;
    return {
      // 一旦有会话认领了这次 arm，就把它落成具体 peer 并**取消武装**：
      // 否则同一段武装期里第二个会话也会被误判成一次性（后端只有一个会话位，
      // 但拒绝后重开会话是真实路径）。
      // 过期的 arm 在这里一并清掉——留着它只会在下次进会话时再算一遍过期。
      state: { armedAt: armed && !addPeer ? s.armedAt : 0, baseline: s.baseline, peers, live },
      forget: [],
    };
  }

  // 空闲 = 结账点。只忘「真的连上过」的：申请被拒 / 对方没在线时不该删设备
  // （那台设备可能压根没建成行，删了也无害；但保留下来用户还能重试一次）。
  const forget = s.live.filter((p) => s.peers.includes(p));
  if (!forget.length) {
    // 没过期就留着（用户可能还在等人）；过期了顺手清掉 baseline，别一直落盘。
    return { state: { ...s, armedAt: armed ? s.armedAt : 0, baseline: armed ? s.baseline : [] }, forget: [] };
  }
  return {
    state: {
      armedAt: armed ? s.armedAt : 0,
      baseline: armed ? s.baseline : [],
      peers: s.peers.filter((p) => !forget.includes(p)),
      live: s.live.filter((p) => !forget.includes(p)),
    },
    forget,
  };
}
