import { useState, useEffect, useCallback } from "react";
import { kbHealth, healthIssueKinds, hasUnfiledAi, type KbHealth } from "@/lib/api/kbHealth";
import styles from "./KbHealthBar.module.css";

/**
 * 知识库顶部那条「库里有 N 项可以修」（N3 库体检）。
 *
 * # 形状照抄 `KbSyncStatusBar`
 *
 * 那条已经是知识库顶部「只在有话说时才出现」的状态条，本组件用同一套：
 * 分档 tone 配色、每行右侧一个 ×、跟着行语气色走的下划线文字链。
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
 * 但**体检没跑成**不能跟着返 null（U3.5）：那样它与「库很健康」
 * 在屏幕上逐像素相同，用户会把「没查成」读成「查过了，没问题」。
 *
 * # 只导航，不代改
 *
 * 没有任何「一键修」。合并要复用 AM-3 的「遇同名跳过并告警」守卫，
 * 而 AM-3 至今零代码（详见 `data_store/note_health.rs` 模块文档）。
 *
 * # 样式全在 CSS Module 里
 *
 * 原先是 17 处内联 `style={{}}`。搬出去不是为了「好看」，而是因为内联 style
 * 写不了 `:hover` / `:focus-visible`（里面十几个 <button> 键盘用户看不见焦点），
 * 也不接受主题覆盖。详见 `KbHealthBar.module.css` 头部。
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
  /** U3.5：kbHealth() 只在**出错**时返 null，所以这个标位足以区分「没查成」与「没问题」。 */
  const [loadFailed, setLoadFailed] = useState(false);
  /** 重试计数：只是用来重跑下面那个 effect。 */
  const [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});
  const [hidden, setHidden] = useState(false);
  /** 🔴 「体检没跑成」那条的关闭，**必须与 `hidden` 分开**。
   *  合用一个的话：用户关掉「这次没查成」→ 之后改了笔记、体检重跑并成功、
   *  真查出来一堆断链重名——整条栏却因为 `hidden` 还是 true 而不再出现。
   *  他关的是「别报失败」，不是「本次会话都别告诉我库里有问题」。 */
  const [failDismissed, setFailDismissed] = useState(false);

  useEffect(() => {
    let alive = true;
    void kbHealth().then((h) => {
      if (!alive) return;
      setHealth(h);
      setLoadFailed(h === null);
    });
    return () => {
      alive = false;
    };
  }, [version, retry]);

  // 压掉的行只管当前会话，**不写进配置**（照抄同步条）：
  // 这些提示本来就该在问题修好后自己消失。
  const drop = useCallback(
    (key: string) => setDismissed((d) => ({ ...d, [key]: true })),
    [],
  );

  if (hidden) return null;

  // U3.5：体检没跑成得说一声。不弹 toast（api 层已经有意不弹），
  // 但也不能静默消失成「库很健康」。句子里先把「不影响你用」说清楚，
  // 否则一条红字会让人以为库坏了——实际上只是体检这一项没算出来。
  if (loadFailed && !failDismissed) {
    return (
      <div className={styles.bar}>
        <div className={styles.loadFail}>
          <span className={styles.statusText}>
            库体检没跑成（不影响看笔记和搜索）
          </span>
          <button type="button" className={styles.retryBtn} onClick={() => setRetry((n) => n + 1)}>
            重试
          </button>
          <button
            type="button"
            className={styles.dismiss}
            onClick={() => setFailDismissed(true)}
            title="本次不再提示体检失败"
            aria-label="本次不再提示体检失败"
          >
            ×
          </button>
        </div>
      </div>
    );
  }

  if (!health) return null;
  const kinds = healthIssueKinds(health);
  if (kinds === 0) return null;

  const row = (key: string, tone: "warn" | "info", body: React.ReactNode) => {
    if (dismissed[key]) return null;
    return (
      <div key={key} className={`${styles.row} ${tone === "warn" ? styles.rowWarn : styles.rowInfo}`}>
        <div className={styles.rowBody}>{body}</div>
        <button
          type="button"
          className={styles.dismiss}
          onClick={() => drop(key)}
          title="本次不再提示"
          aria-label="本次不再提示"
        >
          ×
        </button>
      </div>
    );
  };

  /** 「还有 N 条」——明细封顶 5 条，不说的话截断就是静默的。 */
  const more = (shown: number, total: number) =>
    total > shown ? <span className={styles.muted}>（还有 {total - shown} 条未列出）</span> : null;

  const s = health.stats;

  return (
    <div className={styles.bar}>
      <div className={styles.status}>
        <span className={styles.dot} />
        {/* 数的是**类别**不是条目，理由见 healthIssueKinds 的注释 */}
        <span className={styles.statusText}>库里有 <b>{kinds} 项</b>可以修</span>
        <button type="button" className={styles.expandBtn} onClick={() => setExpanded((v) => !v)}>
          {expanded ? "收起 ▴" : "展开 ▾"}
        </button>
        <button
          type="button"
          className={styles.dismiss}
          onClick={() => setHidden(true)}
          title="本次不再提示"
          aria-label="本次不再提示"
        >
          ×
        </button>
      </div>

      {expanded && (
        <>
          {health.broken_count > 0 && row("broken", "warn", <>
            <b>{health.broken_count} 条断链</b>
            <div className={styles.detail}>
              方括号里的标题在库里找不到（指向回收站里那篇也算，用户看不到它）。
              {health.broken_links.map((b, i) => (
                <div key={`${b.from_id}-${b.to_title}-${i}`} className={styles.item}>
                  <button type="button" className={styles.linkBtn} onClick={() => onOpenNote(b.from_id)}>
                    《{b.from_title}》
                  </button>
                  <span className={styles.muted}> → [[{b.to_title}]]</span>
                </div>
              ))}
              {more(health.broken_links.length, health.broken_count)}
            </div>
          </>)}

          {health.tag_dup_count > 0 && row("tag-dup", "warn", <>
            <b>{health.tag_dup_count} 组标签看着是同一个</b>
            <div className={styles.detail}>
              会被当成两个标签，按名字筛选时只能筛到一半。点标签名可筛出用了它的笔记。
              {health.tag_dups.map((g, i) => (
                <div key={`tag-${i}`} className={styles.item}>
                  {g.names.map((n, j) => (
                    <span key={n}>
                      {j > 0 && <span className={styles.muted}> / </span>}
                      <button type="button" className={styles.linkBtn} onClick={() => onFilterTag(n)}>{n}</button>
                    </span>
                  ))}
                  {!g.strong && (
                    <span className={styles.muted}>（差 {g.distance} 个字，不一定是同一个）</span>
                  )}
                </div>
              ))}
              {more(health.tag_dups.length, health.tag_dup_count)}
            </div>
          </>)}

          {health.title_dup_count > 0 && row("title-dup", "warn", <>
            <b>{health.title_dup_count} 组标题看着是同一篇</b>
            <div className={styles.detail}>
              <code>[[标题]]</code> 是按名字解析的，标题分叉时链接会指错或谁都指不到，
              <b>而不会有任何报错</b>。
              {health.title_dups.map((g, i) => (
                <div key={`title-${i}`} className={styles.item}>
                  {g.names.map((n, j) => (
                    <span key={n}>
                      {j > 0 && <span className={styles.muted}> / </span>}
                      <button type="button" className={styles.linkBtn} onClick={() => onSearch(n)}>{n}</button>
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
            <div className={styles.detail}>
              可能是误建或没写完。
              {health.tiny_notes.map((t) => (
                <div key={t.id} className={styles.item}>
                  <button type="button" className={styles.linkBtn} onClick={() => onOpenNote(t.id)}>
                    {t.title || "（无标题）"}
                  </button>
                  <span className={styles.muted}> · {t.len} 字</span>
                </div>
              ))}
              {more(health.tiny_notes.length, health.tiny_count)}
            </div>
          </>)}

          {/* AI 写的、还没归类的。
              用 info 而不是 warn：这不是库坏了，是 AI 的活儿还剩一截。
              判据走 hasUnfiledAi（门槛在那边），别在这里另写一个 `> 0`——
              那样会出现「顶部条说只有 1 项，展开却多一行」。 */}
          {hasUnfiledAi(health) && row("unfiled-ai", "info", <>
            <b>AI 写了 {health.unfiled_ai_count} 篇还堆在未分类</b>
            <div className={styles.detail}>
              它建了夹子却没把自己写的东西收进去。下次跟它说一声让它归一下类即可
              ——它只动自己写的，不会碰你亲手写的笔记。
              {health.unfiled_ai.map((t) => (
                <div key={t.id} className={styles.item}>
                  <button type="button" className={styles.linkBtn} onClick={() => onOpenNote(t.id)}>
                    {t.title || "（无标题）"}
                  </button>
                </div>
              ))}
              {more(health.unfiled_ai.length, health.unfiled_ai_count)}
            </div>
          </>)}

          {/* 中性统计：无 ×、无动作。「超大笔记」就落在这里而不单列一档——
              AM-2 节级命中上线后，「长」已经不影响检索了。 */}
          {/* 未分类总数也在这里，**不是问题项**：真库上能到 96%，
              那是「没用这个功能」。该报的只有 AI 自己写的那一半（上面那一行）。 */}
          <div className={styles.stats}>
            {s.note_count} 篇（{s.unfiled_count} 篇未分类）
            {" · "}平均 {s.avg_len.toLocaleString()} 字 · 最长 {s.max_len.toLocaleString()} 字
            {" · "}{s.tag_count} 个标签 · {s.link_count} 条 [[ ]] 链接
          </div>
        </>
      )}
    </div>
  );
}
