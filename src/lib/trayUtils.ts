/**
 * TrayPopup 纯逻辑函数（从 TrayPopup.tsx 提取）
 *
 * 将托盘弹窗中的格式化、路由、映射等纯逻辑抽离为可测试的函数，
 * 保护 M9 重构（TrayPopup 共享基础设施提取）。
 */

// ===== 类型 =====

export interface TrayRecentItem {
  id: string;
  text: string;
  type: string;
  content: string;
  time: string;
}

export interface TrayStatsData {
  today_count: number;
  total_count: number;
  db_size_kb: number;
  max_size_mb: number;
}

export interface MenuItemDef {
  id: string;
  label: string;
  hint?: string;
  danger?: boolean;
  iconClass: string;
}

// ===== 格式化 =====

/** 将 KB 数值格式化为人类可读的字符串 */
export function formatDbSize(kb: number): string {
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** 计算数据库占用百分比（0–100），null 安全 */
export function calcMemPercent(stats: TrayStatsData | null): number {
  if (!stats) return 0;
  if (stats.max_size_mb <= 0) return 0;
  return Math.min((stats.db_size_kb / 1024 / stats.max_size_mb) * 100, 100);
}

// ===== 菜单构建 =====

/** 根据监听状态构建菜单项列表 */
export function buildMenuItems(monitoring: boolean): MenuItemDef[] {
  return [
    {
      id: "show",
      iconClass: "icon-blue",
      label: "显示主窗口",
      hint: "Ctrl+Alt+V",
    },
    {
      id: "toggle_monitor",
      iconClass: "icon-orange",
      label: monitoring ? "暂停监听" : "恢复监听",
    },
    {
      id: "settings",
      iconClass: "icon-gray",
      label: "设置…",
      hint: "Ctrl+S",
    },
    {
      id: "exit",
      iconClass: "icon-red",
      label: "退出",
      danger: true,
    },
  ];
}

// ===== 键盘导航索引 =====

/** 向下导航：索引 +1，不超过 maxIndex */
export function clampIndexDown(current: number, maxIndex: number): number {
  return Math.min(current + 1, maxIndex);
}

/** 向上导航：索引 -1，不低于 0 */
export function clampIndexUp(current: number): number {
  return Math.max(current - 1, 0);
}

// ===== 粘贴路由 =====

export interface PasteTarget {
  method: "image" | "text";
  payload: string;
}

/** 根据条目类型决定粘贴方式和载荷 */
export function resolvePasteTarget(item: TrayRecentItem): PasteTarget {
  if (item.type === "image" && item.content) {
    return { method: "image", payload: item.content };
  }
  if (item.type === "file" && item.content) {
    return { method: "text", payload: item.content };
  }
  return { method: "text", payload: item.text };
}

// ===== 类型图标/颜色映射 =====

/** 根据条目类型返回 emoji 图标 */
export function getTypeIcon(type: string): string {
  if (type === "image") return "🖼";
  if (type === "file") return "📁";
  return "📝";
}

/** 根据条目类型返回图标颜色类名 */
export function getTypeColor(type: string): string {
  if (type === "image") return "icon-purple";
  if (type === "file") return "icon-orange";
  return "icon-blue";
}
