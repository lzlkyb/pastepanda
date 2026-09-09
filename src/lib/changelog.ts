// ─── Types ─────────────────────────────────────────────

export type ChangeCategoryType = "feat" | "fix" | "change" | "security" | "perf" | "tech" | "stability" | "uiux" | "other";

export interface ChangeItem {
  text: string;
  /** 有什么用：一句话价值说明（仅「新增」类需要，用于发版弹框功能卡片） */
  why?: string;
  /** 怎么用：操作步骤（1–3 步），用于发版弹框功能卡片 */
  how?: string[];
  /** 配图：插图 key（ocr / mosaic / eraser，由 Canvas 实时绘制，零图片文件）；也可写真实图片路径（如 shots/ocr.jpg），此时走 <img> 且失败降级 */
  media?: string;
}

export interface ChangeGroup {
  label: string;
  items: ChangeItem[];
}

export interface ChangeCategory {
  type: ChangeCategoryType;
  name: string;        // Display name (e.g. "新增", "修复")
  items?: ChangeItem[];
  groups?: ChangeGroup[];
}

export interface ChangelogEntry {
  version: string;
  date: string;
  summary: string;
  categories: ChangeCategory[];
}

// ─── Utilities ─────────────────────────────────────────

/** Compare two semver strings. Returns -1, 0, or 1.
 *  Non-semver input (e.g. "[Unreleased]") is treated as lowest (-1,-1,-1),
 *  so it always sorts below any real version and equals itself. */
export function compareVersions(a: string, b: string): number {
  const [a1, a2, a3] = parseVersion(a);
  const [b1, b2, b3] = parseVersion(b);
  if (a1 !== b1) return a1 > b1 ? 1 : -1;
  if (a2 !== b2) return a2 > b2 ? 1 : -1;
  if (a3 !== b3) return a3 > b3 ? 1 : -1;
  return 0;
}

function parseVersion(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec((v ?? "").trim());
  if (!m) return [-1, -1, -1];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Whether a string is a real semver (x.y.z) — used to guard marking seen. */
export function isVersioned(v: string | null | undefined): boolean {
  return !!v && /^\d+\.\d+\.\d+$/.test(v);
}

export const LAST_SEEN_KEY = "pastepanda_last_seen_version";

/** Custom event dispatched after setLastSeenVersion so same-window listeners
 *  (e.g. TopBar red-dot) refresh. The native `storage` event does NOT fire in
 *  the window that made the change, and Tauri is a single webview anyway. */
export const LAST_SEEN_CHANGED_EVENT = "pp:last-seen-changed";

/** Get the last version the user saw changelog for */
export function getLastSeenVersion(): string | null {
  return localStorage.getItem(LAST_SEEN_KEY);
}

/** Mark a version as seen (also notifies same-window listeners) */
export function setLastSeenVersion(version: string): void {
  localStorage.setItem(LAST_SEEN_KEY, version);
  try {
    window.dispatchEvent(new Event(LAST_SEEN_CHANGED_EVENT));
  } catch {
    /* ignore */
  }
}

/** Check if there are unseen changelog entries since the given version */
export function hasUnseenEntries(entries: ChangelogEntry[], sinceVersion: string): boolean {
  return entries.some(e => compareVersions(e.version, sinceVersion) > 0);
}

/** Get all entries newer than the given version */
export function getUnseenEntries(entries: ChangelogEntry[], sinceVersion: string): ChangelogEntry[] {
  return entries.filter(e => compareVersions(e.version, sinceVersion) > 0);
}

/**
 * 更新日志分类的展示色。
 *
 * 🔴 写字面值而不是 `var(--cat-*, …)`（2026-09-09 改）：
 *   那七个 `--cat-*` 在 `theme.css` 里**从未定义**，于是六套主题下一直用的
 *   就是后面那个兜底值。继续写 `var()` 只会让人以为它们跟主题。
 *
 * 为何不指向现有 token：这是一套**分类谱**，需要 8 个互相可区分的色相，
 * 而主题里只有 accent / green / orange / danger 四支主色——不够分，
 * 硬凑会让两三个分类撞成同一个颜色。真要让它跟主题，得单独设一族
 * 分类谱 token（同「金色该新增 --gold」那条待办）。
 */
export const CATEGORY_COLORS: Record<ChangeCategoryType, string> = {
  feat: "#6366F1",
  fix: "#F59E0B",
  change: "#8B5CF6",
  security: "#EF4444",
  perf: "#10B981",
  tech: "#64748B",
  stability: "#F97316",
  uiux: "#10B981",
  other: "#7888A0",
};

/** Category icon mapping */
export const CATEGORY_ICONS: Record<ChangeCategoryType, string> = {
  feat: "✨",
  fix: "🐛",
  change: "🔄",
  security: "🔒",
  perf: "⚡",
  tech: "🔧",
  stability: "🛡️",
  uiux: "🎨",
  other: "📦",
};

/** Count total items in a category */
export function countCategoryItems(cat: ChangeCategory): number {
  if (cat.items) return cat.items.length;
  if (cat.groups) return cat.groups.reduce((sum, g) => sum + g.items.length, 0);
  return 0;
}

/** Count total items across all categories in an entry */
export function countEntryItems(entry: ChangelogEntry): number {
  return entry.categories.reduce((sum, cat) => sum + countCategoryItems(cat), 0);
}
