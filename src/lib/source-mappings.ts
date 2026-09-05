/**
 * 统一来源映射表
 * 所有来源应用、AI 标签、文件类型的图标/颜色/别名/清洗规则集中管理
 */

// ==================== 类型定义 ====================

/** 来源元数据 */
export interface SourceMeta {
  /** 显示名称 */
  displayName: string;
  /** emoji 图标 */
  icon: string;
  /** 颜色（用于侧边栏圆点等） */
  color?: string;
  /** 匹配别名（用于模糊匹配原始 source，子串包含匹配） */
  aliases?: string[];
  /**
   * 精确匹配别名：要求清洗后的应用名与该别名完全相等（大小写不敏感），而非子串包含。
   * 用于“Code”这类过于宽泛、容易被子串误匹配的短别名（Xcode/Codecademy/CodePen/QR Code 都会命中普通子串匹配，
   * 但不会与它们完全相等）
   */
  exactAliases?: string[];
  /** 清洗规则：正则匹配原始 source，返回该 displayName */
  matchPatterns?: RegExp[];
}

// ==================== 来源应用映射 ====================

/** 来源应用 → 图标 + 清洗规则 */
export const SOURCE_MAP: SourceMeta[] = [
  {
    displayName: "VS Code",
    icon: "💻",
    color: "#3B82F6",
    // "Code"/"code" 作为泛英文词汇过于宽泛，不能用子串包含匹配（会误中 Xcode/Codecademy/CodePen/QR Code），
    // 改用 exactAliases 要求应用名与它完全相等（仅匹配窗口标题确实就叫 "Code" 的真实 VS Code 窗口）
    // "VS Code" 是两个词的具体名称，子串匹配不会误中 Xcode/CodePen 这类，必须保留（它是真实最常见的应用名）
    aliases: ["Visual Studio Code", "VS Code", "vscode", "CodeBuddy"],
    exactAliases: ["Code"],
    matchPatterns: [/Visual Studio Code/i, /VS ?Code/i, /vscode/i, /CodeBuddy/i],
  },
  {
    displayName: "Chrome",
    icon: "🌐",
    color: "#22C55E",
    aliases: ["Google Chrome", "chrome", "Chrome"],
    matchPatterns: [/Google Chrome/i, /Chrome/i],
  },
  {
    displayName: "微信",
    icon: "💬",
    color: "#10B981",
    aliases: ["WeChat", "wechat"],
    // 精确匹配"微信"，排除"企业微信"
    matchPatterns: [/^微信($|\s|—)/i, /^WeChat($|\s|—)/i],
  },
  {
    displayName: "企业微信",
    icon: "💼",
    color: "#059669",
    aliases: ["WeCom", "wecom"],
    matchPatterns: [/企业微信/i, /WeCom/i],
  },
  {
    displayName: "Terminal",
    icon: "⚡",
    color: "#6B7280",
    aliases: ["terminal", "cmd", "PowerShell", "命令提示符"],
    // 🔴 必须带词边界：无锚点的 `/Terminal/i` 会把 **Xterminal**（真库 191 条，
    // 一个独立的终端软件）认成系统 Terminal——开头那个 X 就这么没了。
    // `/cmd/i` 同理，任何含 cmd 的串都会中。
    // 中文那条不加 `\b`：JS 的 `\b` 按 ASCII 词字符判定，加了反而匹不上。
    matchPatterns: [/\bTerminal\b/i, /\bPowerShell\b/i, /\bcmd\b/i, /命令提示符/],
  },
  {
    displayName: "Figma",
    icon: "🎨",
    color: "#A855F7",
    aliases: ["figma"],
    matchPatterns: [/Figma/i],
  },
  {
    displayName: "Notion",
    icon: "📝",
    color: "#1A1A1A",
    aliases: ["notion"],
    matchPatterns: [/Notion/i],
  },
  {
    displayName: "Slack",
    icon: "💬",
    color: "#E01E5A",
    aliases: ["slack"],
    matchPatterns: [/Slack/i],
  },
  {
    displayName: "截图工具",
    icon: "✂️",
    color: "#F97316",
    aliases: ["Snipping Tool", "截图", "Snipaste"],
    matchPatterns: [/Snipping Tool/i, /截图/i, /Snipaste/i],
  },
  {
    displayName: "资源管理器",
    icon: "📁",
    color: "#F59E0B",
    aliases: ["File Explorer", "explorer", "资源管理器"],
    matchPatterns: [/资源管理器/i, /File Explorer/i, /^[A-Z]:\\/i],
  },
  {
    displayName: "DevTools",
    icon: "🛠️",
    color: "#3B82F6",
    aliases: ["DevTools"],
    matchPatterns: [/^DevTools/i],
  },
  {
    displayName: "PastePanda",
    icon: "🐼",
    color: "#EC4899",
    aliases: ["PastePanda"],
    matchPatterns: [/^PastePanda/i],
  },
  {
    displayName: "局域网",
    icon: "📡",
    color: "#14B8A6",
    aliases: ["局域网"],
    matchPatterns: [/^局域网/],
  },
];

// ==================== AI 自动标签映射 ====================

/** AI 自动标签 → 图标 + 颜色 */
export const AUTO_TAG_MAP: SourceMeta[] = [
  { displayName: "代码", icon: "💻", color: "#6366F1" },
  { displayName: "链接", icon: "🔗", color: "#3B82F6" },
  { displayName: "JSON", icon: "📋", color: "#F59E0B" },
  { displayName: "配置文件", icon: "⚙️", color: "#8B5CF6" },
  { displayName: "表格", icon: "📊", color: "#22C55E" },
  { displayName: "命令行", icon: "⬛", color: "#6B7280" },
  { displayName: "日志", icon: "📜", color: "#EF4444" },
  { displayName: "密钥", icon: "🔑", color: "#F97316" },
  { displayName: "数字", icon: "🔢", color: "#14B8A6" },
  { displayName: "纯文本", icon: "📝", color: "#9CA3AF" },
  { displayName: "邮箱", icon: "📧", color: "#2563EB" },
  { displayName: "电话", icon: "📞", color: "#16A34A" },
  { displayName: "颜色", icon: "🌈", color: "#EC4899" },
  { displayName: "文件路径", icon: "📂", color: "#EA580C" },
  { displayName: "Markdown", icon: "Ⓜ️", color: "#84CC16" },
  { displayName: "Python", icon: "🐍", color: "#3776AB" },
  { displayName: "JavaScript", icon: "🟨", color: "#F7DF1E" },
  { displayName: "TypeScript", icon: "🔷", color: "#3178C6" },
  { displayName: "Rust", icon: "🦀", color: "#DEA584" },
  { displayName: "Java", icon: "☕", color: "#ED8B00" },
  { displayName: "Go", icon: "🔵", color: "#00ADD8" },
  { displayName: "SQL", icon: "🗄️", color: "#336791" },
  { displayName: "HTML", icon: "🌐", color: "#E34F26" },
  { displayName: "CSS", icon: "🎨", color: "#1572B6" },
  { displayName: "Shell", icon: "💲", color: "#4EAA25" },
];

// ==================== 文件类型映射 ====================

/** 文件扩展名 → 图标 + 颜色 */
export const FILE_TYPE_MAP: Record<string, { icon: string; color: string }> = {
  // 文档
  pdf: { icon: "📕", color: "linear-gradient(135deg, #EF4444, #DC2626)" },
  doc: { icon: "📘", color: "linear-gradient(135deg, #3B82F6, #2563EB)" },
  docx: { icon: "📘", color: "linear-gradient(135deg, #3B82F6, #2563EB)" },
  xls: { icon: "📗", color: "linear-gradient(135deg, #10B981, #059669)" },
  xlsx: { icon: "📗", color: "linear-gradient(135deg, #10B981, #059669)" },
  ppt: { icon: "📙", color: "linear-gradient(135deg, #F59E0B, #D97706)" },
  pptx: { icon: "📙", color: "linear-gradient(135deg, #F59E0B, #D97706)" },
  txt: { icon: "📄", color: "linear-gradient(135deg, #9CA3AF, #6B7280)" },
  md: { icon: "📝", color: "linear-gradient(135deg, #6B7280, #4B5563)" },
  // 图片
  png: { icon: "🖼️", color: "linear-gradient(135deg, #8B5CF6, #7C3AED)" },
  jpg: { icon: "🖼️", color: "linear-gradient(135deg, #8B5CF6, #7C3AED)" },
  jpeg: { icon: "🖼️", color: "linear-gradient(135deg, #8B5CF6, #7C3AED)" },
  gif: { icon: "🖼️", color: "linear-gradient(135deg, #8B5CF6, #7C3AED)" },
  webp: { icon: "🖼️", color: "linear-gradient(135deg, #8B5CF6, #7C3AED)" },
  bmp: { icon: "🖼️", color: "linear-gradient(135deg, #8B5CF6, #7C3AED)" },
  svg: { icon: "🖼️", color: "linear-gradient(135deg, #8B5CF6, #7C3AED)" },
  // 视频
  mp4: { icon: "🎬", color: "linear-gradient(135deg, #EC4899, #DB2777)" },
  avi: { icon: "🎬", color: "linear-gradient(135deg, #EC4899, #DB2777)" },
  mkv: { icon: "🎬", color: "linear-gradient(135deg, #EC4899, #DB2777)" },
  mov: { icon: "🎬", color: "linear-gradient(135deg, #EC4899, #DB2777)" },
  wmv: { icon: "🎬", color: "linear-gradient(135deg, #EC4899, #DB2777)" },
  // 音频
  mp3: { icon: "🎵", color: "linear-gradient(135deg, #14B8A6, #0D9488)" },
  wav: { icon: "🎵", color: "linear-gradient(135deg, #14B8A6, #0D9488)" },
  flac: { icon: "🎵", color: "linear-gradient(135deg, #14B8A6, #0D9488)" },
  aac: { icon: "🎵", color: "linear-gradient(135deg, #14B8A6, #0D9488)" },
  // 压缩包
  zip: { icon: "📦", color: "linear-gradient(135deg, #78716C, #57534E)" },
  rar: { icon: "📦", color: "linear-gradient(135deg, #78716C, #57534E)" },
  "7z": { icon: "📦", color: "linear-gradient(135deg, #78716C, #57534E)" },
  tar: { icon: "📦", color: "linear-gradient(135deg, #78716C, #57534E)" },
  gz: { icon: "📦", color: "linear-gradient(135deg, #78716C, #57534E)" },
  // 可执行文件
  exe: { icon: "⚙️", color: "linear-gradient(135deg, #78716C, #57534E)" },
  msi: { icon: "⚙️", color: "linear-gradient(135deg, #78716C, #57534E)" },
  dll: { icon: "⚙️", color: "linear-gradient(135deg, #78716C, #57534E)" },
  // 代码
  html: { icon: "🌐", color: "linear-gradient(135deg, #E34F26, #D97706)" },
  css: { icon: "🎨", color: "linear-gradient(135deg, #1572B6, #2563EB)" },
  js: { icon: "📜", color: "linear-gradient(135deg, #F7DF1E, #D97706)" },
  ts: { icon: "📜", color: "linear-gradient(135deg, #3178C6, #2563EB)" },
  jsx: { icon: "📜", color: "linear-gradient(135deg, #61DAFB, #3B82F6)" },
  tsx: { icon: "📜", color: "linear-gradient(135deg, #3178C6, #2563EB)" },
  py: { icon: "🐍", color: "linear-gradient(135deg, #3776AB, #306998)" },
  rs: { icon: "🦀", color: "linear-gradient(135deg, #DEA584, #C45A3C)" },
  go: { icon: "🔷", color: "linear-gradient(135deg, #00ADD8, #007D9C)" },
  java: { icon: "☕", color: "linear-gradient(135deg, #ED8B00, #D97706)" },
  cpp: { icon: "⚡", color: "linear-gradient(135deg, #00599C, #3B82F6)" },
  c: { icon: "⚡", color: "linear-gradient(135deg, #555555, #6B7280)" },
  // 数据
  json: { icon: "📋", color: "linear-gradient(135deg, #F59E0B, #D97706)" },
  xml: { icon: "📋", color: "linear-gradient(135deg, #F59E0B, #D97706)" },
  yaml: { icon: "📋", color: "linear-gradient(135deg, #F59E0B, #D97706)" },
  yml: { icon: "📋", color: "linear-gradient(135deg, #F59E0B, #D97706)" },
  toml: { icon: "📋", color: "linear-gradient(135deg, #F59E0B, #D97706)" },
};

const DEFAULT_FILE_ICON = "📄";
const DEFAULT_FILE_COLOR = "linear-gradient(135deg, #06B6D4, #0078D4)";
const DEFAULT_AUTO_TAG_ICON = "🏷️";
const DEFAULT_SOURCE_ICON = "🔍";

// ==================== 真实图标缓存（前端） ====================

/** 正在提取中的 source_icon（防止重复请求） */
const pendingExtractions = new Map<string, Promise<string | null>>();

/**
 * 获取来源的真实应用图标 URL
 * 缓存 key 使用 source_icon 文件名（同一进程图标相同，不同窗口标题共享缓存）
 * 先查全局 store 缓存，未命中则通过 IPC 调用 Rust 后端获取完整文件路径
 * 然后用 convertFileSrc 转 asset:// URL
 * 提取失败返回 null（应回退 emoji）
 */
export async function fetchRealSourceIcon(
  source: string,
  sourceIcon?: string | null
): Promise<string | null> {
  if (!source) return null;

  // 缓存 key：优先用 source_icon 文件名（同应用共享），回退用 source 窗口标题
  const cacheKey = sourceIcon || source;

  // 1. 全局 store 缓存命中（通过 zustand getState，避免循环依赖）
  //    使用动态 import 避免模块级循环引用
  const { useAppStore } = await import("@/stores/appStore");
  const cached = useAppStore.getState().realIconCache[cacheKey];
  if (cached !== undefined) {
    return cached;
  }

  // 2. 正在提取中（去重）
  if (pendingExtractions.has(cacheKey)) {
    return pendingExtractions.get(cacheKey)!;
  }

  // 3. 发起提取
  const promise = (async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const { convertFileSrc } = await import("@tauri-apps/api/core");
      const filePath: string | null = await invoke("get_source_app_icon", {
        sourceIcon: sourceIcon ?? null,
        windowTitle: source,
      });
      if (filePath) {
        const url = convertFileSrc(filePath);
        useAppStore.getState().setRealIconUrl(cacheKey, url);
        return url;
      }
      useAppStore.getState().setRealIconUrl(cacheKey, null);
      return null;
    } catch {
      useAppStore.getState().setRealIconUrl(cacheKey, null);
      return null;
    } finally {
      pendingExtractions.delete(cacheKey);
    }
  })();

  pendingExtractions.set(cacheKey, promise);
  return promise;
}

// ==================== 查询接口 ====================

/**
 * 一站式来源解析：清洗原始 source 并返回 { displayName, icon, color }
 * 先用 matchPatterns 正则匹配，再用 aliases 模糊匹配
 */
export function resolveSource(raw: string): { displayName: string; icon: string; color?: string } {
  if (!raw) return { displayName: "", icon: DEFAULT_SOURCE_ICON };

  // 1. 正则匹配（优先，如路径、DevTools 等需要精确匹配的场景）
  for (const entry of SOURCE_MAP) {
    if (entry.matchPatterns) {
      for (const pattern of entry.matchPatterns) {
        if (pattern.test(raw)) {
          return { displayName: entry.displayName, icon: entry.icon, color: entry.color };
        }
      }
    }
  }

  // 2. 窗口标题提取应用名：Windows 的惯例是「文档标题 - 应用名」，取**最后一段**。
  //
  // 🔴 必须同时认连字符 `" - "` 与破折号 `" — "`。
  // 这里原先只拆破折号，而 2026-09-05 真库实测：含 `" - "` 的有 **730 条**，
  // 含 `" — "` 的只有 **16 条**——也就是说这一步对绝大多数真实数据根本没生效，
  // 窗口标题一路滑到第 4 步被截断成「模型对比分析 - DeepSeek…」这种东西。
  // 修后全库 341 个不同 source 归并到 96 个，且 Top 全是干净应用名。
  //
  // ❗ 分隔符**两边必须有空格**（字面匹配 `" - "` 而不是 `"-"`）：
  // 应用名自己带的连字符是紧贴的（`GLM-5.3-Flash`），不能被当分隔符。
  // 两种分隔符长度都是 3，所以偏移量一致。
  //
  // 没有连字符/破折号时再试「 · 」，但**取第一段**——方向与上面相反，不能弄反：
  // Windows 惯例是「文档标题 - 应用名」（应用名在**后**），
  // 而观测到的 " · " 是「应用名 · 副标题」（应用名在**前**），
  // 如「策手 StratHand · 你的 AI 量化副驾」。
  //
  // 为什么放在连字符**之后**而不是并列：真库里 GitHub 那类「Page · repo」
  // 标题全都带着 " - 个人 - Microsoft Edge"，已被上一步接走。只有**既没连字符
  // 又带 " · "** 的才到这里（341 个不同 source 里只有 1 个）。
  // 不修的后果不只是名字长：它自带的 " · " 会和事件标签的分隔符撞车，
  // 整条读成「时间 · 策手 StratHand · 你的… · 3 条」四个字段。
  const dash = Math.max(raw.lastIndexOf(" — "), raw.lastIndexOf(" - "));
  let appName: string;
  if (dash > 0) {
    appName = raw.slice(dash + 3).trim();
  } else {
    // `> 0` 而不是 `>= 0`：标题以 " · " 开头时取第一段会得到空串。
    const dot = raw.indexOf(" · ");
    appName = dot > 0 ? raw.slice(0, dot).trim() : raw;
  }

  // 3. 用提取后的应用名模糊匹配 aliases（先走 exactAliases 全等匹配，再走 aliases 子串包含匹配）
  const lower = appName.toLowerCase();
  for (const entry of SOURCE_MAP) {
    // 精确别名优先：避免 "Code" 这类过宽短别名用子串包含误中 Xcode/CodePen/QR Code 等无关应用
    if (entry.exactAliases?.some((a) => lower === a.toLowerCase())) {
      return { displayName: appName.length > 18 ? appName.slice(0, 17) + "…" : appName, icon: entry.icon, color: entry.color };
    }
    if (entry.aliases) {
      for (const alias of entry.aliases) {
        if (lower.includes(alias.toLowerCase())) {
          return { displayName: appName.length > 18 ? appName.slice(0, 17) + "…" : appName, icon: entry.icon, color: entry.color };
        }
      }
    }
  }

  // 4. 未匹配，截断
  const displayName = appName.length > 18 ? appName.slice(0, 17) + "…" : appName;
  return { displayName, icon: DEFAULT_SOURCE_ICON };
}

/**
 * 清洗来源名称（兼容旧接口）
 */
export function cleanSourceName(raw: string): string {
  return resolveSource(raw).displayName;
}

/**
 * 根据来源名称获取图标（兼容旧接口）
 */
export function getSourceIcon(source: string): string {
  return resolveSource(source).icon;
}

/**
 * 根据 AI 标签名获取图标
 */
export function getAutoTagIcon(name: string): string {
  return AUTO_TAG_MAP.find(t => t.displayName === name)?.icon || DEFAULT_AUTO_TAG_ICON;
}

/**
 * 根据 AI 标签名获取颜色
 */
export function getAutoTagColor(name: string, fallbackIndex?: number): string {
  const found = AUTO_TAG_MAP.find(t => t.displayName === name);
  if (found?.color) return found.color;
  if (fallbackIndex !== undefined) {
    const dotColors = ["#3B82F6", "#22C55E", "#F97316", "#A855F7", "#EF4444", "#EC4899", "#14B8A6", "#F59E0B", "#6366F1"];
    return dotColors[fallbackIndex % dotColors.length];
  }
  return "#6B7280";
}

/**
 * 根据文件名获取文件图标
 */
export function getFileIcon(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return FILE_TYPE_MAP[ext]?.icon || DEFAULT_FILE_ICON;
}

/**
 * 根据文件名获取文件图标颜色
 */
export function getFileIconColor(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return FILE_TYPE_MAP[ext]?.color || DEFAULT_FILE_COLOR;
}
