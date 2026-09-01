/**
 * lib/toolbox.ts — 工具箱条目清单（唯一数据源）。
 *
 * 以前这份数据写在 `TopBar.tsx` 里，因为工具箱是个顶栏下拉面板。D15 把它改成
 * 「工具」模式的主体区后，渲染容器变了但**条目数据一模一样**，所以抽到这里收口
 * （规则 #11）——日后加工具只改一处，不会出现两份不同步的清单。
 *
 * 图标没改：这些 emoji 在工具瓷砖上，与顶栏页签不同屏层级，不存在三模式切换器
 * 那种「📋 已被全部页签占用」的冲突。
 */

export type ToolKey =
  | "sequential"
  | "snippets"
  | "extract"
  | "encoding"
  | "replace"
  | "diff"
  | "diffedit"
  | "difffull"
  | "newdiagram";

export interface ToolItem {
  key: ToolKey;
  icon: string;
  name: string;
  desc: string;
  hue: string;
}

export interface ToolGroup {
  label: string;
  items: ToolItem[];
}

export const TOOLBOX_GROUPS: ToolGroup[] = [
  {
    label: "内容",
    items: [
      { key: "sequential", icon: "📋", name: "依次粘贴", desc: "按顺序逐条粘贴文本 · Ctrl+Alt+Q", hue: "cyan" },
      { key: "snippets", icon: "📝", name: "片段库", desc: "常用文本收藏，一键粘贴", hue: "amber" },
      { key: "extract", icon: "🧲", name: "内容提取", desc: "从记录中批量提取链接 / 邮箱 / 电话", hue: "rose" },
      { key: "newdiagram", icon: "📊", name: "新建流程图", desc: "从零绘制，或让 AI 一键生成", hue: "cyan" },
    ],
  },
  {
    label: "文本处理",
    items: [
      { key: "encoding", icon: "🔤", name: "编码转换", desc: "Base64 / URL / Unicode 编解码", hue: "sky" },
      { key: "replace", icon: "🔁", name: "批量替换", desc: "正则查找替换，支持多条规则", hue: "violet" },
      { key: "diff", icon: "📊", name: "配置对比", desc: "两份配置语义级差异高亮", hue: "green" },
      { key: "diffedit", icon: "🔀", name: "文本对比", desc: "自由对比两段文本 · Ctrl+Shift+D", hue: "green" },
      { key: "difffull", icon: "🪟", name: "全屏文本对比", desc: "独立大窗深编对比 · 读剪贴板预填", hue: "green" },
    ],
  },
];

/** 工具回调表：谁渲染工具箱，就由谁传这张表 */
export type ToolHandlers = Partial<Record<ToolKey, () => void>>;
