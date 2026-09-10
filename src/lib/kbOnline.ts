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
 *
 * # 曾经的死分支（已修，别改回去）
 *
 * 后端的 `transport` 原来**就是用「presence 有没有它的地址」算出来的**
 * （`sync/service.rs` 里旧的 `transport_of`），所以 `transport === "wan"` 与
 * 「live 里有它」**在构造上互斥**——那个「外网」标签是个永远到不了的死分支，
 * WAN 对端一律显示「离线」，尽管它每 30 秒同步一次都成功。
 * （2026-09-07 用户实测：库里 `conn_state=online / transport=wan / last_seen=8s 前`，
 * 界面上写着「离线」。）
 *
 * 现在 `transport` 改成**会话还活着时从 `Connection::paths()` 实测**的值
 * （`sync/path_kind.rs`），与 presence 再无关系，那条互斥也就没了。
 *
 * 但**在线判据仍然取两者的并**：组播听得见 或 后端刚刚真的同步成功过。
 * 实测路径答不了「在不在线」——理由写在 `path_kind.rs` 的模块头（iroh 的
 * `Active` 会残留），别再拿它当在线判据。
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
 * `transport` 那一列的取值 → 徽章上的字。
 *
 * 🔴 `"wan"` 是**旧值**，必须留着：改判据之前落库的行就是这个。
 * 它只说明「不在组播里」，分不出打洞直连还是绕中继——所以照旧写「外网」，
 * 不能假装知道。这些行在下一次同步成功时就会被实测值覆盖。
 */
const PATH_LABEL: Record<string, string> = {
  lan: "局域网",
  direct: "公网直连",
  relay: "绕中继",
  wan: "外网",
};

/**
 * 徽章上那几个字：「局域网」/「公网直连」/「绕中继」/「外网」（旧值）/「离线」。
 *
 * 🔴 `transport` 优先于组播，这与改之前相反。
 * 改之前 `transport` 是猜的，所以宁可信组播；现在它是**上一次同步成功时
 * 数据实际走的那条路**，而组播只证明「同子网可见」。两者会不一致：
 * 组播听得见、数据却在绕中继（AP 隔离挡了打洞但没挡组播）——那正是这个标签
 * 要暴露的事，让组播优先就会把它掩成「局域网」。
 *
 * 代价是刚从中继切回局域网时，标签会滞后至多一个同步周期（30s）才更新；
 * 而把一个持续存在的问题掩掉，比滞后 30 秒糟得多。
 */
export function kbOnlineLabel(d: KbDevice, live: string[], now: number = Date.now()): string {
  if (!isKbDeviceOnline(d, live, now)) return "离线";
  const byPath = PATH_LABEL[d.transport];
  if (byPath) return byPath;
  // 还没成功同步过（`transport` 是空串），但组播听得见 → 至少同子网可达。
  if (live.includes(d.node_id)) return "局域网";
  // 在线却既没测到路径也听不见：说得出的只有「在线」，别编一个方式出来。
  return "在线";
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
 * 有设备在走公共中继吗。
 *
 * ❗ 这不是错误，不能报错：真的异地的设备本来就只能走中继。
 * 但两台本应在同一局域网时，它意味着打洞被挡了，而后果是笔记要绕一趟
 * n0 在欧洲的公共中继（慢，且是真实跨境流量）——这件事值得说一声。
 *
 * 🔴 判据从「在线但听不到它的组播」换成了实测的 `transport === "relay"`。
 * 旧判据把**打洞成功的公网直连**也算成中继（异地两台直连得很好时也会报警），
 * 而那正是加 `direct` 这一档的原因。
 *
 * ❗ 旧值 `"wan"` 不算：它分不出直连与中继，宁可漏报也不误报——
 * 那些行在下一次同步成功时就会被实测值覆盖。
 */
export function hasKbRelayPeer(devices: KbDevice[], live: string[], now: number = Date.now()): boolean {
  return devices.some((d) => isKbDeviceOnline(d, live, now) && d.transport === "relay");
}
