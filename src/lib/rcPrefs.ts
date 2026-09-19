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
