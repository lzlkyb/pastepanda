/**
 * url.ts — URL 解析共享工具。
 * 收敛 Card.tsx / pasteTransform.ts / LinkEditor 里散落的内联 `new URL` 逻辑。
 */

/** 带协议 schemes 的 URL 判定（卡片 hover/右键"在浏览器中打开"入口用） */
export const URL_SCHEME_RE = /^(https?|ftp|file|ws|wss|sftp|telnet|ssh|rdp):\/\//i;

/** 安全解析 URL，失败返回 null */
export function parseUrl(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

/** 提取 hostname（失败返回 fallback，默认原文） */
export function urlHost(text: string, fallback?: string): string {
  return parseUrl(text)?.hostname ?? fallback ?? text;
}

/** 提取 pathname（失败返回 fallback，默认空串） */
export function urlPathname(text: string, fallback = ""): string {
  return parseUrl(text)?.pathname ?? fallback;
}

/** hostname + pathname（"粘贴为纯链接文本"变换用；失败返回原文） */
export function urlHostPath(text: string): string {
  const u = parseUrl(text);
  return u ? u.hostname + u.pathname : text;
}

/** URL 结构拆解结果（LinkEditor 结构卡片用） */
export interface UrlParts {
  /** 协议前缀，如 "https://" */
  protocol: string;
  host: string;
  /** 路径段（不含分隔符） */
  pathSegments: string[];
  /** query 键值对（保持原顺序） */
  query: [string, string][];
  /** 锚点（含 #，如 "#assets"；无则空串） */
  hash: string;
}

/** 把合法 URL 拆成结构化片段；非法输入返回 null */
export function splitUrlParts(text: string): UrlParts | null {
  const u = parseUrl(text.trim());
  if (!u) return null;
  return {
    protocol: u.protocol + "//",
    host: u.host,
    pathSegments: u.pathname.split("/").filter(Boolean),
    query: [...u.searchParams.entries()],
    hash: u.hash,
  };
}

/**
 * file:// URL → Windows 本地路径（opener 插件默认白名单不放行 file://，
 * 此类链接改走后端 open_file_with_system，故需先还原为本地路径）：
 * - file:///C:/a%20b/设计稿.html → C:\a b\设计稿.html（percent 解码还原中文/空格）
 * - file://server/share/x.txt   → \\server\share\x.txt（UNC；后端会按安全策略拦截网络共享）
 * 非 file 协议或解析失败返回 null；含非法百分号序列时保留未解码原文。
 */
export function fileUrlToLocalPath(text: string): string | null {
  const u = parseUrl(text.trim());
  if (!u || u.protocol !== "file:") return null;
  let path = u.hostname
    ? "\\\\" + u.hostname + u.pathname // UNC: file://server/share/x
    : u.pathname.replace(/^\//, "");   // 驱动器: file:///C:/... → C:/...
  try {
    path = decodeURIComponent(path);
  } catch {
    /* 非法百分号序列 → 保留原文 */
  }
  return path.replace(/\//g, "\\");
}
