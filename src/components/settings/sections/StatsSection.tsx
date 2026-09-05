import type { AppConfig } from "@/stores/appStore";
import type { StatsDetail } from "@/lib/api";
import { resolveSource } from "@/lib/source-mappings";
import { useSourceIcon } from "@/hooks/useSourceIcon";
import type { SettingsData } from "@/hooks/useSettingsData";
import styles from "../../Settings.module.css";
import settings from "../../Settings.module.css";

/** 来源榜图标：真实应用图标 / emoji 双模式走 useSourceIcon（规则 #11） */
function SourceRowIcon({ source, sourceIcon, fallbackEmoji, color }: { source: string; sourceIcon?: string | null; fallbackEmoji: string; color?: string }) {
  const { realIconUrl } = useSourceIcon(source, sourceIcon);

  return (
    <span className={styles.bSrcIco} style={color ? { background: `${color}26` } : undefined}>
      {realIconUrl ? (
        <img src={realIconUrl} alt="" className={styles.bSrcIcoImg} />
      ) : (
        fallbackEmoji
      )}
    </span>
  );
}

interface StatsSectionProps {
  config: AppConfig;
  stats: StatsDetail | null;
  statsError?: boolean;
  onRetryStats?: () => void;
  setShowWeekReport: SettingsData["setShowWeekReport"];
  srcOpen: SettingsData["srcOpen"];
  setSrcOpen: SettingsData["setSrcOpen"];
  loadedAt: SettingsData["loadedAt"];
  dash: SettingsData["dash"];
}

// 🔴 必须返回 <>…</> 片段：设置搜索靠遍历容器 children 逐行过滤，包一层 <div>
// 会让它遍历到分区外壳而不是行，搜索静默失效（见 useSettingsData 里的说明）。
export function StatsSection({
  config, stats, statsError, onRetryStats,
  setShowWeekReport, srcOpen, setSrcOpen, loadedAt, dash,
}: StatsSectionProps) {
  return (
    <>
      {/* ── 数据统计 ── */}
      <div className={styles.sSection}>数据统计</div>
      <div className={styles.statsPanel}>
        <div className={styles.statsPanelHeader}>
          📊 剪贴板数据概览
          {loadedAt && <span className={styles.statsHeaderRight}>更新于 {loadedAt}</span>}
        </div>
        {/* 审查：统计加载失败给重试（此前 stats 恒 null 永久空转） */}
        {statsError && !stats && (
          <div className={styles.statsFallback}>
            <span>统计加载失败</span>
            <button className={settings.btnSecondary} onClick={onRetryStats}>重试</button>
          </div>
        )}
        {stats && dash ? (
          <>
            {/* 核心指标 4 格 */}
            <div className={styles.bGrid4}>
              <div className={styles.bCell}>
                <div className={styles.bCellNum}>{stats.total.toLocaleString()}</div>
                <div className={styles.bCellLabel}>总记录</div>
              </div>
              <div className={styles.bCell}>
                <div className={`${styles.bCellNum} ${styles.cGreen}`}>{stats.pinned.toLocaleString()}</div>
                <div className={styles.bCellLabel}>⭐ 收藏</div>
              </div>
              <div className={styles.bCell}>
                <div className={`${styles.bCellNum} ${styles.cAccent}`}>{stats.today.toLocaleString()}</div>
                <div className={styles.bCellLabel}>今日新增</div>
                <div className={styles.bCellDelta}>
                  {dash.delta && (
                    <span className={`${styles.delta} ${dash.delta.up ? styles.deltaUp : styles.deltaDown}`}>{dash.delta.text}</span>
                  )}
                </div>
              </div>
              <div className={styles.bCell}>
                <div className={`${styles.bCellNum} ${styles.cOrange}`}>{stats.yesterday.toLocaleString()}</div>
                <div className={styles.bCellLabel}>昨日</div>
                <div className={styles.bCellDelta}>
                  <span className={styles.bCellAvg}>7日均 {dash.weekAvg}</span>
                </div>
              </div>
            </div>

            {/* v6.4 E 剪贴板周报入口（行为侧写，不读内容） */}
            <div className={styles.subTitle}>
              剪贴板周报
              <span className={styles.subHint}>本周复制/粘贴的行为统计 + AI 解读</span>
              <button
                className={styles.weekReportBtn}
                onClick={() => setShowWeekReport(true)}
              >
                打开周报
              </button>
            </div>

            {/* 近 7 天趋势 */}
            <div className={styles.subTitle}>
              近 7 天趋势
              <span className={styles.subHint}>共 {dash.weekTotal.toLocaleString()} 条 · 悬停查看</span>
            </div>
            <div className={styles.bChartWrap}>
              <div className={styles.bChart}>
                <div className={styles.bGridLine} style={{ top: "22%" }} />
                <div className={styles.bGridLine} style={{ top: "55%" }} />
                <div className={styles.bGridLine} style={{ top: "88%" }} />
                <div className={styles.bBars}>
                  {stats.daily.map((d, i) => {
                    const isToday = i === stats.daily.length - 1;
                    const [, mm, dd] = d.date.split("-");
                    return (
                      <div key={d.date} className={`${styles.bDay} ${isToday ? styles.bDayToday : ""}`}>
                        <span className={styles.bDayVal}>{d.count}</span>
                        <i className={styles.bDayBar} style={{ height: `${Math.max(4, Math.round((d.count / dash.dailyMax) * 100))}%` }} />
                        <span className={styles.bDayLbl}>{isToday ? "今天" : `${Number(mm)}/${Number(dd)}`}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* 时段分布 + 类型占比 */}
            <div className={styles.bTwoCol}>
              <div className={styles.bCard}>
                <div className={styles.bCardTitle}>
                  时段分布
                  {dash.peakHour >= 0 && <span className={styles.bCardHint}>{dash.peakHour} 点峰值</span>}
                </div>
                <div className={styles.bHourBars}>
                  {stats.hours.map((v, i) => (
                    <i
                      key={i}
                      title={`${i} 时 · ${v} 条`}
                      className={dash.hourMax > 0 && v === dash.hourMax ? styles.bHourPeak : undefined}
                      style={{ height: `${Math.max(4, dash.hourMax > 0 ? Math.round((v / dash.hourMax) * 100) : 4)}%` }}
                    />
                  ))}
                </div>
                <div className={styles.bHourLbl}>
                  <span>0</span><span>6</span><span>12</span><span>18</span><span>24</span>
                </div>
              </div>
              <div className={styles.bCard}>
                <div className={styles.bCardTitle}>类型占比</div>
                <div className={styles.bDonutRow}>
                  <svg width="62" height="62" viewBox="0 0 76 76">
                    <g transform="rotate(-90 38 38)">
                      <circle cx="38" cy="38" r="30" fill="none" stroke="var(--input-bg)" strokeWidth="10" />
                      <circle cx="38" cy="38" r="30" fill="none" stroke="var(--accent)" strokeWidth="10"
                        strokeDasharray={`${dash.textArc} ${dash.C - dash.textArc}`} strokeDashoffset="0" />
                      <circle cx="38" cy="38" r="30" fill="none" stroke="var(--teal, #2DD4BF)" strokeWidth="10"
                        strokeDasharray={`${dash.imageArc} ${dash.C - dash.imageArc}`} strokeDashoffset={-dash.textArc} />
                      <circle cx="38" cy="38" r="30" fill="none" stroke="var(--orange)" strokeWidth="10"
                        strokeDasharray={`${dash.fileArc} ${dash.C - dash.fileArc}`} strokeDashoffset={-(dash.textArc + dash.imageArc)} />
                    </g>
                    <text x="38" y="42" textAnchor="middle" fontSize="12" fontWeight="700" fill="var(--text-primary)">{dash.textPct}%</text>
                  </svg>
                  <div className={styles.bDonutLegend}>
                    <div className={styles.bLegItem}><i className={styles.bLegDot} style={{ background: "var(--accent)" }} />文本<b>{stats.text_count.toLocaleString()}</b></div>
                    <div className={styles.bLegItem}><i className={styles.bLegDot} style={{ background: "var(--teal, #2DD4BF)" }} />图片<b>{stats.image_count.toLocaleString()}</b></div>
                    <div className={styles.bLegItem}><i className={styles.bLegDot} style={{ background: "var(--orange)" }} />文件<b>{stats.file_count.toLocaleString()}</b></div>
                  </div>
                </div>
              </div>
            </div>

            {/* 来源 Top 5（默认折叠） */}
            {stats.sources.length > 0 && (
              <>
                <button
                  type="button"
                  className={`${styles.srcHead} ${srcOpen ? styles.srcHeadOpen : ""}`}
                  onClick={() => setSrcOpen((v) => !v)}
                >
                  <span className={styles.srcChev}>
                    <svg width="10" height="10" viewBox="0 0 10 10">
                      <path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                  <span className={styles.srcTitle}>来源 Top 5</span>
                  <span className={styles.srcHint}>按复制次数</span>
                  {dash.srcSummary && <span className={styles.srcSummary}>{dash.srcSummary}</span>}
                </button>
                <div className={`${styles.srcBody} ${srcOpen ? styles.srcBodyOpen : ""}`}>
                  {stats.sources.map((s, i) => {
                    const meta = resolveSource(s.source);
                    return (
                      <div className={styles.bSrcRow} key={s.source}>
                        <span className={`${styles.bSrcRank} ${i < 3 ? styles.bSrcRankTop : ""}`}>{i + 1}</span>
                        <SourceRowIcon source={s.source} sourceIcon={s.source_icon} fallbackEmoji={meta.icon} color={meta.color} />
                        <span className={styles.bSrcName}>{meta.displayName || s.source}</span>
                        <span className={styles.bSrcTrack}>
                          <span className={styles.bSrcFill} style={{ width: `${Math.max(4, Math.round((s.count / dash.srcMax) * 100))}%` }} />
                        </span>
                        <span className={styles.bSrcCnt}>{s.count.toLocaleString()}</span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            <div className={styles.statsPanelFooter}>
              <span>💾 {stats.db_size_kb.toFixed(1)} KB</span>
              {stats.earliest_time && <span>📅 最早 {stats.earliest_time.split(" ")[0]}</span>}
              <span>📦 {config.current_workspace || "默认"}空间</span>
            </div>
          </>
        ) : (
          <div style={{ padding: "16px 0", textAlign: "center", fontSize: 12, color: "var(--text-muted)", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
            <span style={{ display: "inline-block", width: 14, height: 14, border: "2px solid var(--border-color)", borderTopColor: "var(--accent)", borderRadius: "50%", animation: "fab-icon-spin 0.6s linear infinite" }} />
            加载统计数据…
          </div>
        )}
      </div>
    </>
  );
}
