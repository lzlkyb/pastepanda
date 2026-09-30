/**
 * rcKeyMode — 键盘模式与输入法守卫的**判据**（乙-①，2026-09-30）。
 *
 * 对标结论（审计稿 §6.7）：RustDesk 的 map/scancode/translate、TeamViewer 的自动/直接
 * 都是**会话内显式开关**，没有一家靠自动判定成功过。所以这里只有两档、且默认必须写明：
 *
 * - `type`（打字模式，默认）：按键按 VK 翻译注入；输入法选字完成后把**最终字符串**
 *   按 Unicode 送对端（待拍板 ① 的「发」）⇒ 能打出中文，游戏里可能错位。
 * - `direct`（直传模式）：按键按 scancode 原样注入（游戏/快捷键准）；输入法选字结果
 *   **不发**（发不了——scancode 语义下没有「字符」这个概念，硬发就成了混两种模式）。
 *
 * 两档都是显式的：切档只由用户点胶囊那颗键触发，本模块不看网络、不看焦点。
 */

export type RcKeyMode = "type" | "direct";

/** config 键名（与 `rc_clip_auto` / `rc_hover_reveal` 同族）。 */
export const RC_KEY_MODE_KEY = "rc_key_mode";

/** 认不出的值（旧版本 / 手改 config / 缺键）一律退回默认档，不报错。 */
export function rcKeyModeOf(raw: unknown): RcKeyMode {
  return raw === "direct" ? "direct" : "type";
}

/** 与 `rcClipAutoFromConfig` / `rcHoverRevealFromConfig` 同一口径的读法收口。 */
export function rcKeyModeFromConfig(config: unknown): RcKeyMode {
  if (!config || typeof config !== "object") return "type";
  return rcKeyModeOf((config as Record<string, unknown>)[RC_KEY_MODE_KEY]);
}

/** 胶囊一级那颗键的读数（两个字，装得进 34px 高的胶囊）。 */
export function rcKeyModeLabel(mode: RcKeyMode): string {
  return mode === "type" ? "打字" : "直传";
}

export function rcKeyModeTip(mode: RcKeyMode): string {
  return mode === "type"
    ? "打字模式：按键按字符翻译，中文可输入（输入法选完字把字符串发给对方），游戏里可能错位"
    : "直传模式：按键按物理扫描码原样送，游戏与快捷键准，中文打不出（输入法选字结果不发）";
}

/** 出口条那句切档确认（规则 15.1：触发与反馈同层）。 */
export function rcKeyModeSwitchedLabel(mode: RcKeyMode): string {
  return mode === "type" ? "已切到打字模式（中文可输入）" : "已切到直传模式（按键按扫描码）";
}

/**
 * 输入法候选期间一律不发键。判据取三条并集，缺一条都会漏：
 * - `composing`：`compositionstart` 已经起闸，覆盖候选框开着时的每一键；
 * - `isComposing`：事件自己承认在组合中（与上面的闸互为兜底，谁先到算谁）；
 * - `keyCode === 229` / `key === "Process"`：**Windows IME 的第一颗键**。
 *   中文输入法截获按键时，浏览器把它报成「未识别键」，此时 compositionstart
 *   可能还没派发——少了这条，拼音首字母会先漏进对端再开始组合。
 */
export function imeIntercepted(
  e: { isComposing?: boolean; keyCode?: number; key?: string },
  composing: boolean,
): boolean {
  if (composing) return true;
  if (e.isComposing) return true;
  if (e.keyCode === 229) return true;
  return e.key === "Process";
}

/**
 * 选字确认后发什么（待拍板 ①：发，但只在打字模式发）。
 * 空串 / 只有回车之类无文本的收尾一律不发——那正是「选字的 Enter 被当成回车」
 * 那条要拦的东西。
 */
export function rcImeCommitOf(mode: RcKeyMode, data: string | undefined | null): string | null {
  if (mode !== "type") return null;
  const text = data ?? "";
  return text && text !== "\n" && text !== "\r" ? text : null;
}
