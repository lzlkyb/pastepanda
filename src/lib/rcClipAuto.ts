/**
 * rcClipAuto — 远程会话「剪贴板自动同步」偏好的读取收口
 * （2026-09-25，B 方案：默认开 + 记住关闭）。
 *
 * 为什么收口：「从 config 读剪贴板同步偏好」带默认值语义（缺键 / 脏值 → 默认开）。
 * 写死在组件里的话，下一个读这个键的人（新窗口 / 新功能）仍会漏掉默认分支——
 * 收口成纯函数 + 守卫单测（规则 11.1）。写入走 appStore 的 `updateConfig`
 * + `save_config`，与设置页同一份持久化值。
 * （注意与 lib/rcPrefs 的分工：那边的偏好只影响工作台窗口自身行为，走 localStorage；
 * 本键是用户级「要不要自动同步」的选择，进 config 才能跨会话、跨窗口一致。）
 */

/** config 里的键名（AppConfig.rc_clip_auto；后端 config 为自由 JSON，键名即线格式）。 */
export const RC_CLIP_AUTO_KEY = "rc_clip_auto";

/**
 * 剪贴板自动同步偏好。**缺键 / 非布尔脏值一律默认开**——
 * 旧用户配置里没有这个键，升级后的语义必须是「默认开启」。
 */
export function rcClipAutoFromConfig(config: unknown): boolean {
  if (!config || typeof config !== "object") return true;
  const v = (config as Record<string, unknown>)[RC_CLIP_AUTO_KEY];
  return typeof v === "boolean" ? v : true;
}
