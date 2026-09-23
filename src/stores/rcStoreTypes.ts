/**
 * rcStore 的 state 形状定义（从 `src/stores/rcStore.ts` 拆分而来，仅搬类型、
 * 不改行为）。原始 `rcStore.ts` 现为 `useRcStore` 的 re-export 门面，所有
 * `from "@/stores/rcStore"` 的引用继续原样工作。
 */
import type {
  RcCapability,
  RcCaptureScope,
  RcIdentity,
  RcInvite,
  RcInviteCreated,
  RcPathChanged,
  RcQuality,
  RcStatus,
  RcTargetDevice,
  RcUnoCreated,
} from "@/lib/api/rc";

export type RcReachability = {
  state: "checking" | "reachable" | "unreachable" | "error";
  checkedAt?: number;
};

export interface RcState {
  status: RcStatus | null;
  targets: RcTargetDevice[];
  targetsLoaded: boolean;
  targetsError: string | null;
  reachability: Record<string, RcReachability>;
  identity: RcIdentity | null;
  busy: boolean;
  /** B4：并发操作计数——先完成者不得提前解除后到者的禁用 */
  busyCount: number;
  /** B1：用户刚主动清掉的后端错误串——同串在清除生效前被轮询拿回时不回显 */
  lastClearedError: string | null;
  /** P3-4：同串忽略窗口的起点（Date.now()）。配合 lastClearedError 只吞短窗口内的同串。 */
  lastClearedAt: number;
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
  refreshTargets: () => Promise<RcTargetDevice[] | null>;
  /** 对指定设备做短连接确认，结果只更新内存中的临时状态，不改历史在线时间。 */
  probeTargets: (only?: string[]) => Promise<void>;
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
