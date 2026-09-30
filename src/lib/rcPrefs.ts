/**
 * rcPrefs — 「远程电脑」工作台的**前端偏好**（localStorage，不动后端配置）。
 *
 * 为什么不进后端 config：这两项只影响这个窗口自己的行为（打开时要不要自动
 * 开通道 / 发起时预选哪一档），不参与任何协议与鉴权判断——与
 * `lib/rcRequest.ts` 的「上次设备 / 上次档」同一家族。隐私模式下 localStorage
 * 会抛异常：读 → 回默认值，写 → 静默丢弃，都不能让工作台打不开。
 */

/** 打开工作台时自动启动远程通道。默认开——打开工作台这个动作本身就是意图。 */
const LS_AUTO_CHANNEL = "rc_wb_auto_channel";

export function readAutoStartChannel(): boolean {
  try {
    const v = localStorage.getItem(LS_AUTO_CHANNEL);
    return v === null ? true : v === "1";
  } catch {
    return true;
  }
}

export function writeAutoStartChannel(v: boolean): void {
  try {
    localStorage.setItem(LS_AUTO_CHANNEL, v ? "1" : "0");
  } catch {
    /* ignore：隐私模式写不进去，本次会话内设置仍然生效（内存态） */
  }
}

/* ── 设置页「远程电脑」四个折叠组的开合 ───────────────────────────── */
/* 同上面那条的理由：纯浏览偏好，不参与任何协议判断，不该进 config——
   `save_config` 每次全量明文备份，点一下组头就落一次盘是浪费。 */

export type RcSettingsGroup = "pair" | "conn" | "cap" | "recent";

/**
 * 首次进入 = 这套默认。只有「谁能连进来」展开：它是唯一一个「可能有请求正在等你
 * 点头」的组，收起来等于漏单（其余三组都是静态配置）。
 */
export const RC_GROUP_DEFAULTS: Record<RcSettingsGroup, boolean> = {
  pair: true,
  conn: false,
  cap: false,
  recent: false,
};

const LS_GROUP_OPEN = "rc_settings_groups";

export function readRcGroupOpen(): Record<RcSettingsGroup, boolean> {
  const out = { ...RC_GROUP_DEFAULTS };
  try {
    const raw = localStorage.getItem(LS_GROUP_OPEN);
    if (!raw) return out;
    const saved = JSON.parse(raw) as Record<string, unknown>;
    for (const k of Object.keys(out) as RcSettingsGroup[]) {
      // 只认明确的 0 / 1：缺键或脏值一律回默认，不能让一次写坏把「待确认」那组藏掉
      if (saved[k] === 0 || saved[k] === 1) out[k] = saved[k] === 1;
    }
  } catch {
    /* ignore：读不到就用默认值 */
  }
  return out;
}

export function writeRcGroupOpen(map: Record<RcSettingsGroup, boolean>): void {
  try {
    const packed: Record<string, 0 | 1> = {};
    for (const [k, v] of Object.entries(map)) packed[k] = v ? 1 : 0;
    localStorage.setItem(LS_GROUP_OPEN, JSON.stringify(packed));
  } catch {
    /* ignore：写不进去只是下次进来回到默认开合 */
  }
}

/**
 * 某个组此刻该不该展开。**搜索期间强制全展开**（设计稿 §5 ① 拍板），退出搜索回到用户态。
 *
 * 判据收在这一个函数里而不是散在组件的 `open={...}` 上：四个组 + 将来的第五个组
 * 都得同一口径，漏一处就是「搜得到但看不见」那种静默失效。
 * 纯判断单独导出，便于无环境守卫单测（规则 11.1）。
 */
export function rcGroupShouldOpen(userOpen: boolean, filter: string): boolean {
  return filter.trim() !== "" || userOpen;
}
