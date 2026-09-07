/**
 * kbOnline.ts —— 知识库同步设备的「在线 / 走哪条路」判据。
 *
 * # 🔴 为何要有这个文件（改回去前先读）
 *
 * 改之前三个地方各自写了 `live.includes(d.node_id)`：
 * `KbSyncPanel` 的计数与每一行、以及知识库模式的 `KbSyncStatusBar`。
 * 而 `live` 来自 `presence.live()`，它的含义是**组播听得见**，不是「能同步」。
 *
 * 两者差别大到能直接报错：同步走的是 iroh QUIC（可直连、也可过中继），
 * 而组播只要被 AP 隔离 / 防火墙挡住 5008 / 两台不在同一子网 / 走 VPN，就完全听不到。
 * 更致命的是：后端的 `transport` **就是用「presence 有没有它的地址」算出来的**
 * （`sync/service.rs` 的 `transport_of`），所以 `transport === "wan"` 与
 * 「live 里有它」**在构造上互斥**——旧写法下那个「外网」标签是个永远到不了的死分支，
 * WAN 对端一律显示「离线」，尽管它每 30 秒同步一次都成功。
 * （2026-09-07 用户实测：库里 `conn_state=online / transport=wan / last_seen=8s 前`，
 * 界面上写着「离线」。）
 *
 * 所以判据要取**两者的并**：组播听得见 或 后端刚刚真的同步成功过。
 */
import type { KbDevice, KbLastSync } from "@/hooks/useKbSync";

/**
 * `last_seen` 多旧就不再算在线（毫秒）。
 *
 * 同步周期是 30s ± 10s 抖动（`coordinate::PERIOD_SECS` / `JITTER_SECS`），
 * 两个周期还没动静就不该再说「在线」。
 *
 * ❗ 它不是给「对端跑了」兜底的——那种情况下下一拨就会失败并把 `conn_state`
 * 写成 offline。它兜的是**进程被杀 / 异常退出**：那时 `conn_state` 会定在 online，
 * 下次开机在首次同步前会拿着一个陈旧的 online 显示。
 */
export const ONLINE_STALE_MS = 90_000;

/**
 * 这台设备现在算不算在线。
 *
 * @param live `kb_sync_devices` 返回的组播在线名单（= `presence.live()`）。
 * @param now 注入时间便于测试；生产省略。
 */
export function isKbDeviceOnline(d: KbDevice, live: string[], now: number = Date.now()): boolean {
  // 组播听得见 = 局域网肯定可达，最强的证据。
  if (live.includes(d.node_id)) return true;
  // 听不见也可能正在好好同步（直连打洞 / 过中继）——信后端那份。
  return d.conn_state === "online" && d.last_seen > 0 && now - d.last_seen <= ONLINE_STALE_MS;
}

/** 在线的设备数。 */
export function countKbOnline(devices: KbDevice[], live: string[], now: number = Date.now()): number {
  return devices.filter((d) => isKbDeviceOnline(d, live, now)).length;
}

/**
 * 徽章上那三个字：「局域网」/「外网」/「离线」。
 *
 * ❗ 组播听得见就写「局域网」，**不看** `transport`：后者记的是上一次
 * 握手走的路，而组播是此刻的事实。两者瞬时不一致时（刚从外网切回局域网）
 * 应以新的为准。
 */
export function kbOnlineLabel(d: KbDevice, live: string[], now: number = Date.now()): string {
  if (live.includes(d.node_id)) return "局域网";
  if (!isKbDeviceOnline(d, live, now)) return "离线";
  return d.transport === "wan" ? "外网" : "局域网";
}

/**
 * 设备行上要多说的一句话。`null` = 没什么要说。
 *
 * 🔴 为何要有：后端早就把可操作的原因算好了（`LastSync::error`，
 * 例如「对方还没把这台设备加回去——到那台机器的「知识库同步」里确认连接请求」），
 * 而设置面板从来没渲染过 `last`——用户在那里只能看到一个不解释原因的「离线」。
 * （知识库模式的 `KbSyncStatusBar` 有显，但那是另一个入口。）
 *
 * ❗ 只在**离线**时说。在线但上一拨失败过是常态（碰撞、一次丢包），
 * 那种时候报错只会把人吓住。
 */
export function kbDeviceProblem(
  d: KbDevice,
  last: KbLastSync[],
  live: string[],
  now: number = Date.now(),
): string | null {
  if (isKbDeviceOnline(d, live, now)) return null;
  // 后端给的原因最准，优先用。
  const l = last.find((x) => x.peer === d.node_id);
  if (l && l.fails > 0 && l.error) return l.error;
  // 🔴 配过对却一次都没连上过：几乎肯定是单边配对的残留
  //    （修之前生成邀请码那一台不写自己的设备表，于是把对方每次连接都拒掉）。
  //    不说的话它就是一行永远离线、用户不知道能做什么的尸体。
  if (d.last_seen === 0) {
    return "从来没连上过。多半是对方那台没把这台加回去——到那边确认连接请求，或者先「忘记」再重新配一次";
  }
  return null;
}

/**
 * 有设备在走公共中继吗（= 在线但听不到它的组播）。
 *
 * ❗ 这不是错误，不能报错：真的异地的设备本来就只能走中继。
 * 但两台本应在同一局域网时，它意味着组播被挡了，而后果是笔记要绕一趟
 * n0 在欧洲的公共中继（慢，且是真实跨境流量）——这件事值得说一声。
 */
export function hasKbRelayPeer(devices: KbDevice[], live: string[], now: number = Date.now()): boolean {
  return devices.some((d) => isKbDeviceOnline(d, live, now) && !live.includes(d.node_id));
}
