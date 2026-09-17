/**
 * 远程电脑 · 局域网 6 位数字配对（A3）—— 对应 `src-tauri/src/commands/rc_pair.rs`。
 *
 * 与 `lib/api/rc.ts` **分开**：那边是邀请码 / 会话 / 目标列表（700+ 行的命令层），
 * 这边是**独立的一条路**——不走邀请码、不走 Endpoint 握手，靠 presence 上的
 * 明文包 + 6 位数字核对完成。后端同样把命令层拆成两个文件，这里对齐。
 *
 * # 与邀请码那条路的关系
 *
 * 邀请码是**兜底**：不在同一局域网时只能靠带外渠道搬一串码。局域网这条路把
 * 「搬字符串」整个消掉，而且**信任强度更高**（中间人换公钥会让两端数字对不上）。
 * 两条路配完之后写的是同一张 `rc_devices`，界面上没有区别。
 *
 * 字段名与 Rust 一致（snake_case）。失败由调用方处理，这里不吞。
 */
import { invoke } from "@tauri-apps/api/core";

/** 同网段里**还没配对**的邻居（已配对的在 `rcTargets` 里，不在这一份）。 */
export interface RcNeighbor {
  node_id: string;
  /** 对方自报的名字，可能为空串。**不可信**，界面要与指纹一起标注。 */
  name: string;
  /** 对端自报的可达地址 `ip:port`。仅诊断用，界面不展示。 */
  addr: string;
  /** 本机最后一次听到它的时刻（本机时钟，epoch 毫秒）。 */
  last_seen_ms: number;
}

/** 正在进行的那一轮配对。 */
export interface RcPairPrompt {
  peer_id: string;
  peer_name: string;
  /** 6 位数字；空串 = 还在等对方的公钥（界面显示「正在与对方核对…」）。 */
  pin: string;
  /** 本端是不是发起方。只影响文案。 */
  initiator: boolean;
  /** 本端已点确认。 */
  me_ok: boolean;
  /** 对方已回「我这侧也确认了」。 */
  peer_ok: boolean;
  started_ms: number;
}

/** 刚配对成功的那一台（后端**读完即清**，前端要留在自己状态里）。 */
export interface RcPairDone {
  peer_id: string;
  peer_name: string;
  /** 本端是不是发起方 —— 决定完成屏给「立刻发起远程」还是「知道了」。 */
  initiator: boolean;
  at_ms: number;
}

export interface RcNearbyStatus {
  neighbors: RcNeighbor[];
  pair: RcPairPrompt | null;
  done: RcPairDone | null;
}

export interface RcPairOutcome {
  /** waiting = 本端确认了、等对方；committed = 两端都确认、**已配对**；gone = 会话已过期。 */
  state: "waiting" | "committed" | "gone";
  peer_id: string;
  peer_name: string;
}

/**
 * 附近设备 + 当前配对状态。
 *
 * ❗ 后端在这条命令里**顺带重传**该重传的握手包（见 `commands/rc_pair.rs`），
 * 所以界面对话框开着时要保持 2 秒一轮——关掉轮询等于放弃 UDP 丢包的重传机会。
 */
export function rcNearbyStatus(): Promise<RcNearbyStatus> {
  return invoke<RcNearbyStatus>("rc_nearby_status");
}

export function rcNearbyPair(peerId: string): Promise<RcPairPrompt> {
  return invoke<RcPairPrompt>("rc_nearby_pair", { peerId });
}

export function rcNearbyConfirm(): Promise<RcPairOutcome> {
  return invoke<RcPairOutcome>("rc_nearby_confirm");
}

/** 返回是否记了一次「拒绝」（本端是被请求方时才记）。 */
export function rcNearbyCancel(): Promise<boolean> {
  return invoke<boolean>("rc_nearby_cancel");
}
