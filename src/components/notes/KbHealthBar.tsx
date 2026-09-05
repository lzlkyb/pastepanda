import { useState, useEffect, useCallback } from "react";
import { kbHealth, healthIssueKinds, type KbHealth } from "@/lib/api/kbHealth";

/**
 * 知识库顶部那条「库里有 N 项可以修」（N3 库体检）。
 *
 * # 形状照抄 `KbSyncStatusBar`
 *
 * 那条已经是知识库顶部「只在有话说时才出现」的状态条，本组件用同一套：
 * 三档 tone 配色、每行右侧一个 ×、`--accent-strong` 下划线文字链。
 * 两条形态不一致的话，看起来就像两个不同来源的东西叠在一起。
 *
 * # 默认折叠
 *
 * 同步条最坏情况会展开到 5~6 行（时钟偏斜 / 冲突 / 没传完 / 连不上……）。
 * 体检再铺开就把笔记列表挤没了，所以默认只占一行。
 *
 * # 全好时返 null
 *
 * **不显示「✅ 库很健康」**——那是没有信息量的一行，
 * AM-8 的先例是「只在真有重复时才占字」。
 *
 * # 只导航，不代改
 *
 * 没有任何「一键修」。合并要复用 AM-3 的「遇同名跳过并告警」守卫，
 * 而 AM-3 至今零代码（详见 `data_store/note_health.rs` 模块文档）。
 */
export function KbHealthBar({
  version,
  onOpenNote,
  onSearch,
  onFilterTag,
}: {
  /** 笔记增删改的版本号；变了就重算。**不做定时轮询**——同步条那个 10 秒是因为
   *  对端状态在变，而体检只会因为本机改了笔记而变。 */
  version: number;
  onOpenNote: (id: string) => void;
  /** 标题重名那一行靠它搜出同名的几篇。 */
  onSearch: (keyword: string) => void;
  /** 点重名标签 → 筛出用了它的笔记。解析不到 id 时调用方返 false，届时渲染成纯文字。 */
  onFilterTag: (name: string) => boolean;
}) {
  const [health, setHealth] = useState<KbHealth | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let alive = true;
    void kbHealth().then((h) => {
      if (alive) setHealth(h);
    });
    return () => {
      alive = false;
    };
  }, [version]);

  // 压掉的行只管当前会话，**不写进配置**（照抄同步条）：
  // 这些提示本来就该在问题修好后自己消失。
  const drop = useCallback(
    (key: string) => setDismissed((d) => ({ ...d, [key]: true })),
    [],
  );

  if (hidden || !health) return null;
  const kinds = healthIssueKinds(health);
  if (kinds === 0) return null;

  const lnk: React.CSSProperties = {
    border: "none", background: "transparent", padding: 0, cursor: "pointer",
    color: "var(--accent-strong)", fontSize: 12, textDecoration: "underline",
  };
  const xBtn: React.CSSProperties = {
    border: "none", background: "transparent", cursor: "pointer",
    color: "var(--text-muted)", fontSize: 13, lineHeight: 1, padding: 0,
  };

  const row = (key: string, tone: "warn" | "info", body: React.ReactNode) => {
    if (dismissed[key]) return null;
    return (
      <div key={key} style={{
        display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 14px",
        background: tone === "warn" ? "var(--orange-bg)" : "transparent",
        borderTop: "1px solid var(--border-color)", fontSize: 12,
      }}>
        <div style={{ flex: 1, color: tone === "warn" ? "var(--orange)" : "var(--text-secondary)" }}>
          {body}
        </div>
        <button onClick={() => drop(key)} title="本次不再提示" style={xBtn}>×</button>
      </div>
    );
  };

  const desc: React.CSSProperties = { marginTop: 3, color: "var(--text-secondary)" };
  /** 「还有 N 条」——明细封顶 5 条，不说的话截断就是静默的。 */
  const more = (shown: number, total: number) =>
    total > shown ? <span style={{ color: "var(--text-muted)" }}>（还有 {total - shown} 条未列出）</span> : null;

  const s = health.stats;

  return (
    <div style={{ borderBottom: "1px solid var(--border-color)", background: "var(--card-bg)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 14px", fontSize: 12.5 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", flex: "none", background: "var(--orange)" }} />
        {/* 数的是**类别**不是条目，理由见 healthIssueKinds 的注释 */}
        <span style={{ flex: 1 }}>库里有 <b>{kinds} 项</b>可以修</span>
        <button onClick={() => setExpanded((v) => !v)} style={lnk}>
          {expanded ? "收起 ▴" : "展开 ▾"}
        </button>
        <button onClick={() => setHidden(true)} title="本次不再提示" style={xBtn}>×</button>
      </div>

      {expanded && (
        <>
          {health.broken_count > 0 && row("broken", "warn", <>
            <b>{health.broken_count} 条断链</b>
            <div style={desc}>
              方括号里的标题在库里找不到（指向回收站里那篇也算，用户看不到它）。
              {health.broken_links.map((b, i) => (
                <div key={`${b.from_id}-${b.to_title}-${i}`} style={{ marginTop: 2 }}>
                  <button onClick={() => onOpenNote(b.from_id)} style={lnk}>
                    《{b.from_title}》
                  </button>
                  <span style={{ color: "var(--text-muted)" }}> → [[{b.to_title}]]</span>
                </div>
              ))}
              {more(health.broken_links.length, health.broken_count)}
            </div>
          </>)}

          {health.tag_dup_count > 0 && row("tag-dup", "warn", <>
            <b>{health.tag_dup_count} 组标签看着是同一个</b>
            <div style={desc}>
              会被当成两个标签，按名字筛选时只能筛到一半。点标签名可筛出用了它的笔记。
              {health.tag_dups.map((g, i) => (
                <div key={`tag-${i}`} style={{ marginTop: 2 }}>
                  {g.names.map((n, j) => (
                    <span key={n}>
                      {j > 0 && <span style={{ color: "var(--text-muted)" }}> / </span>}
                      <button onClick={() => onFilterTag(n)} style={lnk}>{n}</button>
                    </span>
                  ))}
                  {!g.strong && (
                    <span style={{ color: "var(--text-muted)" }}>（差 {g.distance} 个字，不一定是同一个）</span>
                  )}
                </div>
              ))}
              {more(health.tag_dups.length, health.tag_dup_count)}
            </div>
          </>)}

          {health.title_dup_count > 0 && row("title-dup", "warn", <>
            <b>{health.title_dup_count} 组标题看着是同一篇</b>
            <div style={desc}>
              <code>[[标题]]</code> 是按名字解析的，标题分叉时链接会指错或谁都指不到，
              <b>而不会有任何报错</b>。
              {health.title_dups.map((g, i) => (
                <div key={`title-${i}`} style={{ marginTop: 2 }}>
                  {g.names.map((n, j) => (
                    <span key={n}>
                      {j > 0 && <span style={{ color: "var(--text-muted)" }}> / </span>}
                      <button onClick={() => onSearch(n)} style={lnk}>{n}</button>
                    </span>
                  ))}
                </div>
              ))}
              {more(health.title_dups.length, health.title_dup_count)}
            </div>
          </>)}

          {/* 故意用 info 而不是 warn：空笔记是「你可能忘了写」，
              不像断链 / 重名那样会真让检索与链接出错。 */}
          {health.tiny_count > 0 && row("tiny", "info", <>
            <b>{health.tiny_count} 篇几乎是空的</b>（不足 50 字）
            <div style={desc}>
              可能是误建或没写完。
              {health.tiny_notes.map((t) => (
                <div key={t.id} style={{ marginTop: 2 }}>
                  <button onClick={() => onOpenNote(t.id)} style={lnk}>
                    {t.title || "（无标题）"}
                  </button>
                  <span style={{ color: "var(--text-muted)" }}> · {t.len} 字</span>
                </div>
              ))}
              {more(health.tiny_notes.length, health.tiny_count)}
            </div>
          </>)}

          {/* 中性统计：无 ×、无动作。「超大笔记」就落在这里而不单列一档——
              AM-2 节级命中上线后，「长」已经不影响检索了。 */}
          <div style={{
            padding: "8px 14px", borderTop: "1px solid var(--border-color)",
            fontSize: 12, color: "var(--text-muted)",
          }}>
            {s.note_count} 篇 · 平均 {s.avg_len.toLocaleString()} 字 · 最长 {s.max_len.toLocaleString()} 字
            {" · "}{s.tag_count} 个标签 · {s.link_count} 条 [[ ]] 链接
          </div>
        </>
      )}
    </div>
  );
}
