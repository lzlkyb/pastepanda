/**
 * rcDevice — 远程设备相关的纯函数（头像样式 / 相对时间 / 默认名）。
 *
 * 抽纯函数是为了让 D1(随机色相头像) / D4(上次控制时间) / C4(默认设备名)
 * 的规范判定可单测、可复用，避免同一段逻辑在多组件里各写一份（C10）。
 */

/** 默认配对设备名（C4：RcSection 与 RcOverlay 的统一来源，避免一处「未命名设备」）。 */
export const DEFAULT_RC_DEVICE_NAME = "新设备";

/**
 * 设备头像样式：固定单色系（基于语义 token --accent 派生），不再随机色相。
 * - 任意 node_id（相同或不同）都得到同一颜色 → 一屏一强调色（V3）；
 * - 背景用 color-mix 控浅、文字用深色 token → 对比度达标（WCAG AA，不再 2.5:1）。
 */
export function deviceAvatarStyle(_nodeId: string): { background: string; color: string } {
  return {
    background: "color-mix(in srgb, var(--accent, #4f7cff) 16%, var(--card-bg, #f6f7f9))",
    color: "var(--text-primary, #1c1f23)",
  };
}

/**
 * 相对时间（「上次控制 · 2 小时前」）。
 * 处理 null/undefined/0（视为从未）、未来时间（归为「刚刚」）、刚发生等边界。
 * @param ms 事件时间戳（ms），可能为 null/undefined/0
 * @param now 当前时间戳（ms），默认 Date.now()
 * @returns 中文相对描述；ms 非法时返回空串（调用方据此不显示空文案，D4）
 */
export function relTime(ms: number | null | undefined, now: number = Date.now()): string {
  if (ms == null || ms <= 0) return "";
  const diff = now - ms;
  if (diff < 0) return "刚刚"; // 未来时间，归为「刚刚」
  if (diff < 60_000) return "刚刚";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  const mon = Math.floor(day / 30);
  return `${mon} 个月前`;
}

/** 设备可达性档位（与后端 `RcPresence` 同构）。 */
export type RcPresenceLevel = "live" | "recent" | "seen" | "never";

/**
 * 后端给的 presence 串归一到四档。未知值按「见过」处理——
 * **刻意不兜底成 "live"**：无中心服务器时组播听不见 ≠ 对端关机，
 * 但反过来把「不知道」说成「在线」更糟（用户会以为对方一定连得上）。
 */
export function normalizeRcPresence(raw: string | undefined): RcPresenceLevel {
  if (raw === "live" || raw === "recent" || raw === "seen" || raw === "never") {
    return raw;
  }
  return "seen";
}

/**
 * 设备行主状态文案（设计稿：多档，不冒充有中心服务器的二值绿点）。
 * 纯函数便于单测；`lastSeen` 为 `relTime` 已格式化串。
 */
export function presenceMainLabel(
  presence: RcPresenceLevel,
  lastSeenLabel: string,
): string {
  switch (presence) {
    case "live":
      return "在线";
    case "recent":
      return lastSeenLabel ? `${lastSeenLabel}还在` : "刚刚还在";
    case "seen":
      return lastSeenLabel ? `${lastSeenLabel}见过` : "见过";
    case "never":
    default:
      return "配对后还没连上过";
  }
}

/** 设备行状态点的 CSS module 类名键。 */
export function presenceDotClass(
  presence: RcPresenceLevel,
): "dotOn" | "dotRecent" | "dotOff" {
  if (presence === "live") return "dotOn";
  if (presence === "recent") return "dotRecent";
  return "dotOff";
}

/** 设备行尾部补充说明（可操作，不是重复主文案）。 */
export function presenceHint(presence: RcPresenceLevel): string {
  switch (presence) {
    case "live":
      return "局域网可达";
    case "recent":
      return "仍可尝试";
    case "seen":
      return "仍可经中继尝试";
    case "never":
    default:
      return "核对指纹后再试，或检查对方远程通道";
  }
}

/**
 * 设备行尾部「上次 …」段。
 *
 * 改前是两个并列的条件 span：「 · 上次 3 天前」与「 · 上次走中继」——
 * 同一条信息（这台设备上次的会话）被拆成两段、各带一个「上次」。
 * 现在合成一段：
 *   - 都有   → 「上次 3 天前 · 走中继」
 *   - 只有路径 → 「上次走中继」（保持 B-5 的原措辞）
 *   - 只有时间 → 「上次 3 天前」
 *   - 都没有 → 空串，整段不渲染（承 B-5 的「空白不编默认值」）
 *
 * @param lastSeenLabel `relTime` 已格式化的串；空串 = 没有可信时间
 * @param showLastSeen  是否显示时间（recent/live 时主文案已含时间，不重复）
 * @param pathLabel     `pathKindLabel` 已格式化的路径；空串 = 还没连过，不编默认值
 */
export function lastSeenHint(
  lastSeenLabel: string,
  showLastSeen: boolean,
  pathLabel: string,
): string {
  const hasTime = showLastSeen && !!lastSeenLabel;
  if (hasTime && pathLabel) return `上次 ${lastSeenLabel} · 走${pathLabel}`;
  if (pathLabel) return `上次走${pathLabel}`;
  if (hasTime) return `上次 ${lastSeenLabel}`;
  return "";
}

/**
 * 备注名长度上限，**按字符数**计。
 *
 * 🔴 与后端 `commands::rc::NOTE_MAX_CHARS` 同值、同口径。两边分开算的代价：
 * 后端曾用 `note.len()`（字节），60 字节只够 20 个汉字，而这里的 `maxLength`
 * 与 `slice` 数的是 UTF-16 单元 —— 21~60 个汉字的备注在前端看着完全合法，
 * 存下去必被后端拒掉。改口径时两处必须一起改。
 */
export const RC_NOTE_MAX = 60;

/**
 * 只按字符截断，不做 trim。
 *
 * 输入过程中不能顺手 trim —— 那样用户打不出「客厅 电脑」这种以空格开头的中缀，
 * 打一个空格就被吃掉。落库前的归一化走 `normalizeRcNote`。
 */
export function truncateRcNote(raw: string): string {
  return Array.from(raw).slice(0, RC_NOTE_MAX).join("");
}

/** 落库前的归一化：trim + 按字符截断（与后端 `normalize_note` 同一口径）。 */
export function normalizeRcNote(raw: string): string {
  return truncateRcNote(raw.trim());
}

/**
 * 设备系统标签（详情面「在线 · Windows 11 · 局域网可达」中间那一段）。
 *
 * 后端给的是对端**自报**的值（会话 `Accept` 帧带来的，本机推断不出来）。
 * 空串 / 空白 / 缺失一律归成空串，调用方据空串**整段不渲染**——不编默认值：
 * 摆一个「未知系统」比留白更糟，那会让用户以为我们真的探测过。
 */
export function osLabel(raw: string | null | undefined): string {
  return (raw ?? "").trim();
}

/**
 * A5：这条会话记录还能不能「再次连接」。
 *
 * 判据缺一即不摆按钮 —— 摆一个注定失败的入口比不摆更糟（本轮反复踩的坑）：
 *  · 通道在跑（`rc_status.running`）：通道没起时 `rc_request_session` 直接回
 *    `[channel_down]`，用户点完只得到一句报错；
 *  · 该设备仍在配对列表里：忘了设备 / 对方重装换了 node_id 之后，旧记录指向的
 *    设备已经不在 `rc_targets`，点了只会得到 `[not_paired]`。
 *
 * 参数取结构化最小类型（只用到 `node_id`），避免这个纯函数模块依赖 api 层。
 */
export function canReconnectTo(
  targets: readonly { node_id: string }[],
  peer: string,
  running: boolean,
): boolean {
  if (!running) return false;
  return targets.some((t) => t.node_id === peer);
}

/**
 * B1：托盘「连接 <设备>」的目标设备。
 *
 * 只认 `source === "rc"` 的设备，且列表已按 `last_seen` 降序（后端如此）——
 * 取第一台 = 最近用过的那台。纯同步配对设备刻意不取：它们在工作台里都被要求
 * 先「去配对」建立远程通道，托盘里更不该绕过这条边界。
 */
export function lastRcTarget<T extends { source: string }>(targets: readonly T[]): T | null {
  return targets.find((t) => t.source === "rc") ?? null;
}

/**
 * A2 侧栏的设备分组键（2026-09-21 批4）。
 *
 * 稿给的是两组「在线 / 最近使用」，而后端可达性是**四档**（live/recent/seen/never）。
 * 这里刻意分三组而不是照稿压成两组：`never`（配对后从没连上过）不属于「最近使用」，
 * 塞进那一组等于把「还没用过」说成「用过」——而文案如实正是这四档存在的全部意义
 * （无中心服务器时组播听不见 ≠ 对端关机，见 `normalizeRcPresence`）。
 * `seen` 与 `recent` 同组：两者差别只是时间远近，都属于「用过、现在仍可能连得上」。
 */
export type RcDeviceGroupKey = "live" | "recent" | "never";

export const RC_DEVICE_GROUP_LABEL: Record<RcDeviceGroupKey, string> = {
  live: "在线",
  recent: "最近使用",
  never: "尚未连接",
};

/** 分组渲染顺序：可达性从高到低。空组不渲染（见 `groupRcTargets`）。 */
const RC_DEVICE_GROUP_ORDER: RcDeviceGroupKey[] = ["live", "recent", "never"];

export function deviceGroupOf(presence: RcPresenceLevel): RcDeviceGroupKey {
  if (presence === "live") return "live";
  if (presence === "never") return "never";
  return "recent";
}

/**
 * 把设备列表切成带计数的小组（稿：`<span>在线</span><span>2</span>`）。
 *
 * 三条不变量，都有守卫单测：
 *  - **组内保持输入顺序**（后端已按 `last_seen` 降序）——重排会让「最近用过哪些」这条线索失效；
 *  - **空组不产出**：一台在线设备都没有时，不该出现一个写着「在线 0」的空标题；
 *  - **总数守恒**：各组 items 长度之和 === 输入长度，一台不丢、一台不重。
 *
 * 参数取结构化最小类型（只用到 `presence`），避免这个纯函数模块反向依赖 api 层。
 */
export function groupRcTargets<T extends { presence?: string }>(
  targets: readonly T[],
): { key: RcDeviceGroupKey; label: string; items: T[] }[] {
  const buckets: Record<RcDeviceGroupKey, T[]> = { live: [], recent: [], never: [] };
  for (const target of targets) {
    buckets[deviceGroupOf(normalizeRcPresence(target.presence))].push(target);
  }
  return RC_DEVICE_GROUP_ORDER.filter((key) => buckets[key].length > 0).map((key) => ({
    key,
    label: RC_DEVICE_GROUP_LABEL[key],
    items: buckets[key],
  }));
}

/**
 * A2 侧栏设备行的第二行（2026-09-21 批4）。
 *
 * 与 `presenceMainLabel` 分开，因为两处的信息预算不同：设备行（`RcDeviceRow` 的
 * `RcDeviceMeta`）第二行已经排了「状态 · 提示 · 上次…」三段，主文案复用最省；
 * 而 A2 侧栏一行只有「名称 + 一行副文案」，且**分组标题已经承担了状态**——
 * 「在线」组里再写一遍「在线」是纯重复，位置该让给**实测路径**（用户在列表里
 * 真正要判断的是「现在连它快不快」）。
 *
 * 反过来，离线设备**不能**这样替换：路径是上次的、可能早已失效，此时「多久前
 * 用过」才是有效信息（稿里「最近使用」组那行也确实是时间）。
 *
 * @param pathLabel `pathKindLabel` 已格式化的路径；空串 = 还没连过，走回落
 */
export function deviceRowSubLabel(
  presence: RcPresenceLevel,
  lastSeenLabel: string,
  pathLabel: string,
): string {
  if (presence === "live") return pathLabel || "在线";
  return presenceMainLabel(presence, lastSeenLabel);
}
