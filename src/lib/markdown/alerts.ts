/**
 * GFM 提示块（`> [!NOTE]` / TIP / IMPORTANT / WARNING / CAUTION）→ 卡片。
 *
 * marked 原生不解析，这里在解析产物（HTML 字符串）上做改写，零依赖。
 * 从 `MarkdownRenderer.tsx` 抽出来的原因：导出管线也要用同一份改写逻辑，
 * 各留一份迟早对不上（编辑器里是卡片、导出文件里是光秃秃的引用块）。
 */

type AlertKind = "NOTE" | "TIP" | "IMPORTANT" | "WARNING" | "CAUTION";

const ALERT_META: Record<AlertKind, { label: string; icon: string }> = {
  NOTE: {
    label: "注意",
    icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm-1 3h2v2H7zm0 3h2v5H7z"/></svg>',
  },
  TIP: {
    label: "提示",
    icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1a5 5 0 0 0-3 9c.6.5 1 1.2 1 2h4c0-.8.4-1.5 1-2a5 5 0 0 0-3-9zM6 13h4v1a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-1z"/></svg>',
  },
  IMPORTANT: {
    label: "重要",
    icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1l1.8 5.2L15 8l-5.2 1.8L8 15l-1.8-5.2L1 8l5.2-1.8L8 1z"/></svg>',
  },
  WARNING: {
    label: "警告",
    icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1 1 14h14L8 1zm-1 5h2v4H7zm0 5h2v2H7z"/></svg>',
  },
  CAUTION: {
    label: "小心",
    icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5 1h6l4 4v6l-4 4H5l-4-4V5l4-4zm2 3v5h2V4H7zm0 6v2h2v-2H7z"/></svg>',
  },
};

const ALERT_OPEN_RE = /^\s*<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(?:<br\s*\/?>)?\s*(<\/p>)?/;

/** 把带 `[!KIND]` 标记的引用块改写成卡片；没标记的原样返回。 */
export function transformAlerts(html: string): string {
  return html.replace(/<blockquote>([\s\S]*?)<\/blockquote>/g, (match, inner: string) => {
    const m = inner.match(ALERT_OPEN_RE);
    if (!m) return match;
    const kind = m[1] as AlertKind;
    const meta = ALERT_META[kind];
    const standalone = !!m[2]; // 标记独占一段（[!NOTE]</p>）vs 与正文同段（[!NOTE]<br>正文）
    const rest = inner.slice(m[0].length);
    const body = standalone ? rest : `<p>${rest}`;
    return (
      `<div class="md-alert md-alert-${kind.toLowerCase()}">` +
      `<span class="md-alert-ic">${meta.icon}</span>` +
      `<div class="md-alert-bd"><p class="md-alert-t">${meta.label}</p>${body}</div>` +
      `</div>`
    );
  });
}
