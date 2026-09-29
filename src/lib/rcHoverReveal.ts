/**
 * rcHoverReveal — 控端浮条「顶缘 hover 唤出」偏好的读取收口
 * （乙档 2026-09-29，design/远程电脑-浮条角标化-乙-设计稿.html §8 待拍板①）。
 *
 * 为什么收口：与 `lib/rcClipAuto` 同一类问题——「从 config 读一个带默认值的布尔」。
 * 缺键必须默认**开**：甲方案（2026-09-29）已经把顶缘唤出收紧到 3px + 180ms dwell，
 * 老用户升级后不该发现这条加速器凭空消失。写死在组件里，下一个读这个键的人
 * 会漏掉缺键分支（规则 11.1），所以这里出纯函数 + 守卫单测。
 *
 * 关掉后的语义 = 「顶缘零触发」：hook 不注册 mousemove，唤出只剩把手与 F10。
 * 这正是 RustDesk 新版的做法（维护者：新 UI 没这问题因为它没有 hover）。
 */

/** config 里的键名（AppConfig.rc_hover_reveal；后端 config 为自由 JSON，键名即线格式）。 */
export const RC_HOVER_REVEAL_KEY = "rc_hover_reveal";

/**
 * 顶缘 hover 唤出偏好。**缺键 / 非布尔脏值一律默认开**——旧配置里没有这个键，
 * 升级后的语义必须是「保留甲方案那条路」，关掉是用户的显式选择。
 */
export function rcHoverRevealFromConfig(config: unknown): boolean {
  if (!config || typeof config !== "object") return true;
  const v = (config as Record<string, unknown>)[RC_HOVER_REVEAL_KEY];
  return typeof v === "boolean" ? v : true;
}
