/**
 * turndown-plugin-gfm 类型声明（@joplin fork）。
 * 该包没有官方类型声明，这里声明最小接口供 TS 编译通过。
 */

declare module "@joplin/turndown-plugin-gfm" {
  import type TurndownService from "turndown";
  /** GFM 插件：表格 / 删除线 / 任务列表 */
  const gfm: TurndownService.Plugin;
  export { gfm };
}
