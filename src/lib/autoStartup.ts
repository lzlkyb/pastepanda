// 开机自启「应用配置 vs 注册表实测」对账的纯判断。
//
// 背景：自启条目会被清理工具删值、被任务管理器禁用（StartupApproved 标记）、
// 因重装换目录而路径过期。后端启动时已对账一次；本函数供设置页挂载时
// 用 `get_startup` 实测再做一次兜底。
//
// 不变量（守卫单测钉住）：对账只会把**配置**收敛到**注册表实测值**，
// 前端绝不存在「反向把注册表改成与配置一致」的动作——改注册表只走
// `set_startup`，且只能由用户显式切换开关触发。

export interface AutoStartupDesync {
  /** "none" = 一致；"sync-config" = 把配置收敛到实测值 */
  action: "none" | "sync-config";
  /** 实测值（action 为 "none" 时等于入参，便于调用方统一取用） */
  registryEnabled: boolean;
  /** 需要给用户的解释；"none" 时为空串 */
  message: string;
}

export function resolveAutoStartupDesync(
  configEnabled: boolean,
  registryEnabled: boolean,
): AutoStartupDesync {
  if (configEnabled === registryEnabled) {
    return { action: "none", registryEnabled, message: "" };
  }
  if (!registryEnabled) {
    return {
      action: "sync-config",
      registryEnabled: false,
      message:
        "检测到开机自启已被系统（任务管理器/设置）或安全软件禁用，已同步关闭；需要时请重新打开此开关",
    };
  }
  return {
    action: "sync-config",
    registryEnabled: true,
    message: "检测到开机自启在系统侧仍处于开启状态，已同步开启",
  };
}
