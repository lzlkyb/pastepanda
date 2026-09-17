/**
 * 栈浮标的状态类型。
 *
 * 单独成文件的原因：它有两个消费方，而它们**不能互相 import**。
 *
 * - `lib/stack/hudBridge.ts`（主窗口侧）：负责产出状态，依赖 appStore；
 * - `components/stack/StackHud.tsx`（浮标窗口侧）：负责渲染状态，**绝不能**引 appStore——
 *   浮标是独立的 webview 与 JS 上下文，主窗口的 store 它拿不到，引进来只会
 *   把整个主窗口依赖图打包进一个小窗。
 *
 * 所以类型下沉到这份零依赖文件。字段与 Rust 侧 `stack_hud::StackHudState`
 * （`#[serde(rename_all = "camelCase")]`）一一对应。
 */
export interface StackHudProgress {
  /** 已成功粘贴条数 */
  done: number;
  /** 本轮总条数（收集数与已粘贴+剩余取 max） */
  total: number;
  /**
   * 覆盖徽章文案（如循环态的「第 2 轮」）。`undefined` = 渲染 `${done}/${total}`。
   *
   * ❗ 循环态必须走这个：那时 `done/total` 会一轮一轮地转圈，
   * 它不指向任何终点，读起来像「怎么贴都贴不完」。
   */
  label?: string;
}

export interface StackHudState {
  /** collecting 收集中 / success 已粘贴 / error 失败 / done 全部完毕 */
  phase: "collecting" | "success" | "error" | "done";
  /** 栈内剩余条数 */
  count: number;
  /** 目标应用可读名；null = 未选定目标 */
  target: string | null;
  /** 覆盖默认副行文案；null = 由 phase 推导 */
  hint: string | null;
  /**
   * 下一条要粘贴的内容预览（`stackItems[0]`）。
   * 预览在主窗口侧由 `hudBridge.ts` 生成（图片/文件给占位符、文字取首行截断）；
   * null = 栈空（done / 刚进入栈模式），浮标不渲染预览行。
   */
  next: string | null;
  /** 粘贴热键（展示用，如 `Ctrl+Alt+P`） */
  hotkey: string;
  /** 粘贴进度徽章；null = 不渲染（如 done 终态）。Rust 侧 serde(default) 兼容旧报文 */
  progress: StackHudProgress | null;
  /**
   * 锚点类型，由 Rust 在 emit 时按最近一次落位注入：
   * control=聚焦输入框（显示方向尾） / window=目标窗口 /
   * cursorWindow=光标下的窗口 / cursor=贴光标兜底
   */
  anchorKind: "control" | "window" | "cursorWindow" | "cursor" | null;
}
