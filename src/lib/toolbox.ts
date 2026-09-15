/**
 * lib/toolbox.ts — 工具箱条目清单（唯一数据源）。
 *
 * 以前这份数据写在 `TopBar.tsx` 里，因为工具箱是个顶栏下拉面板。D15 把它改成
 * 「工具」模式的主体区后，渲染容器变了但**条目数据一模一样**，所以抽到这里收口
 * （规则 #11）——日后加工具只改一处，不会出现两份不同步的清单。
 *
 * 图标没改：这些 emoji 在工具瓷砖上，与顶栏页签不同屏层级，不存在三模式切换器
 * 那种「📋 已被全部页签占用」的冲突。
 *
 * P1：shortcut / hero 从 desc 里拆成独立字段——快捷键要渲染成 kbd 芯片（可扫视），
 * 高频工具要进 hero 行；继续写在句子里这两件事都做不了。
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
  | "newdiagram"
  | "dailybrief"
  | "qr"
  | "sql"
  | "json"
  | "log"
  | "timestamp"
  | "remote";

export interface ToolItem {
  key: ToolKey;
  icon: string;
  name: string;
  /** 只写「干什么」，快捷键走 shortcut 字段 */
  desc: string;
  hue: string;
  /** 显示用快捷键，如 Ctrl+Alt+Q；无则省略 */
  shortcut?: string;
  /** 高频入口，进主体区顶部 hero 双卡 */
  hero?: boolean;
}

export interface ToolGroup {
  label: string;
  items: ToolItem[];
}

export const TOOLBOX_GROUPS: ToolGroup[] = [
  {
    label: "内容",
    items: [
      {
        key: "sequential",
        icon: "📋",
        name: "依次粘贴",
        desc: "按顺序逐条粘贴文本",
        hue: "cyan",
        shortcut: "Ctrl+Alt+Q",
        hero: true,
      },
      {
        key: "snippets",
        icon: "📝",
        name: "片段库",
        desc: "常用文本收藏，一键粘贴",
        hue: "amber",
        hero: true,
      },
      {
        key: "extract",
        icon: "🧲",
        name: "内容提取",
        desc: "从记录中批量提取链接、邮箱、电话",
        hue: "rose",
      },
      {
        key: "newdiagram",
        icon: "📊",
        name: "新建流程图",
        desc: "从零绘制，或让 AI 一键生成",
        hue: "cyan",
      },
      // 不绑热键：规划建议的 Ctrl+Shift+D 已被下面的「文本对比」占用，
      // 而日报是低频动作，不值得为它再抢一个。
      {
        key: "dailybrief",
        icon: "📅",
        name: "今日整理",
        desc: "把今天的碎片按时间理成一条时间线",
        hue: "amber",
      },
    ],
  },
  {
    label: "文本处理",
    items: [
      {
        key: "encoding",
        icon: "🔤",
        name: "编码转换",
        desc: "Base64 / URL / Unicode 编解码",
        hue: "sky",
      },
      {
        key: "replace",
        icon: "🔁",
        name: "批量替换",
        desc: "正则查找替换，支持多条规则",
        hue: "violet",
      },
      {
        key: "diff",
        icon: "📊",
        name: "配置对比",
        desc: "两份配置语义级差异高亮",
        hue: "green",
      },
      {
        key: "diffedit",
        icon: "🔀",
        name: "文本对比",
        desc: "自由对比两段文本",
        hue: "green",
        shortcut: "Ctrl+Shift+D",
      },
      {
        key: "difffull",
        icon: "🪟",
        name: "全屏文本对比",
        desc: "独立大窗深编对比，读剪贴板预填",
        hue: "green",
      },
      {
        key: "qr",
        icon: "▦",
        name: "二维码",
        desc: "文本生成二维码，或识图解码",
        hue: "sky",
      },
      {
        key: "sql",
        icon: "🗄",
        name: "SQL 工具",
        desc: "格式化与校验剪贴板里的 SQL",
        hue: "violet",
      },
      {
        key: "json",
        icon: "🧩",
        name: "JSON 工具",
        desc: "校验、格式化 / 压缩 JSON",
        hue: "cyan",
      },
      {
        key: "log",
        icon: "📜",
        name: "日志分析",
        desc: "级别过滤、错误提取、续行归属",
        hue: "amber",
      },
      {
        key: "timestamp",
        icon: "⏱",
        name: "时间戳 / 数字",
        desc: "时间戳互转、进制、字节速览",
        hue: "rose",
      },
    ],
  },
  {
    label: "网络",
    items: [
      {
        key: "remote",
        icon: "🖥️",
        name: "远程电脑",
        desc: "查看或操作已配对的另一台电脑",
        hue: "sky",
        hero: true,
      },
    ],
  },
];

/** 工具回调表：谁渲染工具箱，就由谁传这张表 */
export type ToolHandlers = Partial<Record<ToolKey, () => void>>;

/** 筛选：名称 / 描述 / 快捷键任一命中即可（大小写不敏感） */
export function filterToolItems(
  items: ToolItem[],
  query: string,
): ToolItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (t) =>
      t.name.toLowerCase().includes(q) ||
      t.desc.toLowerCase().includes(q) ||
      (t.shortcut ?? "").toLowerCase().includes(q),
  );
}

/** 分类 chips：全部 + 各分组 label（顺序与 TOOLBOX_GROUPS 一致） */
export function toolboxCategoryLabels(): string[] {
  return ["全部", ...TOOLBOX_GROUPS.map((g) => g.label)];
}

/** 按分类筛分组；「全部 / 空」返回原列表。 */
export function filterGroupsByCategory(
  groups: ToolGroup[],
  category: string,
): ToolGroup[] {
  const c = category.trim();
  if (!c || c === "全部") return groups;
  return groups.filter((g) => g.label === c);
}

/** 键列表 → 条目（丢掉清单里已删掉的 key，防历史痕迹指向幽灵工具） */
export function toolsByKeys(keys: ToolKey[]): ToolItem[] {
  const all = TOOLBOX_GROUPS.flatMap((g) => g.items);
  const by = new Map(all.map((t) => [t.key, t]));
  return keys.map((k) => by.get(k)).filter((t): t is ToolItem => !!t);
}
