/**
 * 全屏编辑器多标签 —— 纯逻辑（零 React / 零 Tauri 依赖，可直接单测）。
 *
 * 只回答三个问题，其余（渲染、门控、守卫 UI）全在组件层：
 *   ① 这一份「打开请求」该复用已有标签，还是新开一个？（去重键）
 *   ② 还能不能再开？（上限）
 *   ③ 关掉这个标签之后，焦点该落在谁身上？
 *
 * 单独成文件（而不是塞进 useEditorTabs）的理由：这三条都是**规则**，
 * 出错的形态是「同一文件开成两个标签、各自持一份文本，谁后存谁覆盖」这类
 * 静默数据问题，必须能被无环境单测钉住。hook 那一层只剩状态搬运。
 */

/** 同时打开的文档上限。触及上限时由宿主明确提示，而不是静默拒绝一次打开。 */
export const MAX_EDITOR_TABS = 12;

/** 一次「打开文档」请求（Rust 命令参数 / md-editor-load 事件载荷 / 前端调用，三处同形） */
export interface EditorOpenRequest {
  sourceId?: string | null;
  content?: string | null;
  filePath?: string | null;
  contentType?: string | null;
  language?: string | null;
}

/**
 * 标签运行期元信息 —— 由各文档视图在状态变化时上报，标签栏据此渲染。
 *
 * 为什么不从「打开请求」一次性算完：文件名会随另存为与语言切换变化，
 * 脏点/保存态/自动保存失败更是只能由文档自己知道。标签栏要反映的是
 * **此刻**的文档，不是它被打开时的样子。
 */
export interface TabMeta {
  /** 显示用文件名（跟随另存为 / 语言切换变化） */
  fileName: string;
  /** 类型图标字符（与工具栏 fileIcon 同源） */
  icon: string;
  isDirty: boolean;
  isSaving: boolean;
  /** 自动保存写盘失败（标签栏显示红点而非橙点） */
  tabError: boolean;
  /**
   * 本视图**有没有保存能力**。
   *
   * ❗ 必须与 `isDirty` 分开看。diff 全屏就是反例：两栏文本可以改（`isDirty` 为真），
   * 但它没有落盘目标、工具栏上也没有保存按钮（`onSave` 未传 ⇒ 不渲染）。
   * 把这种「本来就没得存」当成「保存失败」，会让关闭守卫**永远拒绝关闭**它 ——
   * 用户被卡在一个只能选「不保存」的对话框里，而那句「有文档未能保存」是假的。
   */
  canSave: boolean;
  /** 专注模式：活动标签进入专注态时隐藏标签栏（chrome 全隐藏） */
  focusMode: boolean;
}

/**
 * 路径规范化：分隔符统一、去掉尾部斜杠、大小写折叠。
 *
 * Windows 上同一个文件会以两种形态到达 —— 文件关联给的是系统原生 `D:\a\B.md`，
 * 用户经「打开文件」对话框选的可能是 `d:/a/b.md`。不折叠就会把同一文件开成
 * 两个标签，而它们各自持有一份文本：谁后保存谁覆盖，中间那份编辑静默消失。
 */
export function normalizeEditorPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * 去重键。返回 `null` 表示「这份内容没有稳定身份」——
 * 新建空白文档、自由文本对比这类既无文件也无来源记录，每次打开都该是新标签，
 * 不能互相命中（否则第二次「新建文本对比」会把你正在比的那份顶掉）。
 *
 * 优先级 `filePath > sourceId`：同一份卡片内容被「另存为」之后文档身份就变成文件，
 * 此后按文件走才不会再撞回原卡片。
 */
export function dedupeKeyOf(req: EditorOpenRequest): string | null {
  if (req.filePath) return `f:${normalizeEditorPath(req.filePath)}`;
  if (req.sourceId) return `s:${req.sourceId}`;
  return null;
}

/** 在已有键序列里找命中下标；无身份或未命中一律 -1（= 应当新开） */
export function findTabIndex(keys: readonly (string | null)[], key: string | null): number {
  if (!key) return -1;
  return keys.indexOf(key);
}

/** 是否还能再开一个。判定与提示分开：这里只判，提示交给宿主。 */
export function canOpenMore(count: number): boolean {
  return count < MAX_EDITOR_TABS;
}

/**
 * 触达上限时的提示文案（**单一来源**）。
 *
 * ❗ 拿到 `accepted: false` 的**每一个**调用点都必须展示它。上限是「拒服务」，
 * 静默拒绝会退化成用户眼里的「点了没反应」「有些文件没打开」—— 与本次改造
 * 要消灭的那条静默丢文档属于同一类问题（反馈必须和触发在同一可见性域）。
 *
 * @param rejected 本次被拒的个数。批量打开（一次多选若干文件 / 建窗期队列）
 *                 传真实数字，单次打开省略 —— 逐条弹 N 个一模一样的 toast
 *                 比不弹更糟，所以调用点要先**合并计数**再调这里。
 */
export function tabLimitMessage(rejected = 0): string {
  return rejected > 0
    ? `最多同时打开 ${MAX_EDITOR_TABS} 个文档，另有 ${rejected} 个未能打开`
    : `最多同时打开 ${MAX_EDITOR_TABS} 个文档`;
}

/**
 * 关闭某个标签后应当激活谁（返回 null 表示已无标签，宿主该关窗）。
 *
 * @param order    当前标签 id 顺序（= 标签栏从左到右的视觉顺序）
 * @param activeId 关闭前的活动标签
 * @param closedId 本次要关的标签
 *
 * 规则：关的不是活动标签 → 活动标签不变（别把用户的视线挪走）；
 * 关的是活动标签 → 接管它原来的**右邻**（删除后正好落在同一下标），
 * 没有右邻则取新的最后一个。这条是「Ctrl+W 连按关掉一串」时的手感来源。
 */
export function nextActiveAfterClose(
  order: readonly string[],
  activeId: string | null,
  closedId: string,
): string | null {
  const idx = order.indexOf(closedId);
  // 关的标签不在列表里（并发关闭等）→ 保持现状，不要顺手把活动标签挪到第一个
  if (idx < 0) return activeId;
  const rest = order.filter((id) => id !== closedId);
  if (rest.length === 0) return null;
  if (closedId !== activeId) return activeId;
  return rest[Math.min(idx, rest.length - 1)];
}
