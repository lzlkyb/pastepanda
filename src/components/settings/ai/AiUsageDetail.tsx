/**
 * 用量明细（默认折叠，展开才拉数据）。
 *
 * **这里看不到任何内容文本**，因为后端的 `ai_usage_log` 表里根本没那个字段。
 * 只有时间、动作、模型、token 数与成败。
 *
 * 自己拉数据而不是由 AiTab 传：大部分人永远不会展开它，没必要每次打开
 * 设置面板都去查三次库。
 */

import { useCallback, useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import {
  aiClearUsageLog,
  aiGetUsageStats,
  aiListActions,
  aiListCustomActions,
  aiListUsageLog,
  type AiUsageLogRow,
  type AiUsageStats,
} from "@/lib/api";
import { logger } from "@/lib/logger";
import settings from "../../Settings.module.css";
import styles from "../AiTab.module.css";

/** 这两个不在动作清单里，得单独给名字，否则明细里会直接显示内部 id */
const EXTRA_LABELS: Record<string, string> = {
  "connection-test": "连通性测试",
  "custom-preview": "自定义动作试跑",
};

/** `2026-08-08 13:45:02` → `08-08 13:45`，列表里秒没有意义 */
function shortTime(s: string): string {
  return s.length >= 16 ? s.slice(5, 16) : s;
}

export function AiUsageDetail() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<AiUsageStats | null>(null);
  const [rows, setRows] = useState<AiUsageLogRow[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>(EXTRA_LABELS);
  const [confirmClear, setConfirmClear] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, r, actions, custom] = await Promise.all([
        aiGetUsageStats(7),
        aiListUsageLog(50),
        aiListActions(),
        aiListCustomActions(),
      ]);
      setStats(s);
      setRows(r);
      // 自定义动作也要进映射，否则明细里会摆出一串 uuid
      const map: Record<string, string> = { ...EXTRA_LABELS };
      actions.forEach((a) => {
        map[a.id] = a.label;
      });
      custom.forEach((a) => {
        map[a.id] = a.name;
      });
      setLabels(map);
    } catch (e) {
      logger.warn("加载 AI 用量明细失败", e);
    } finally {
      setLoading(false);
    }
  }, []);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    setConfirmClear(false);
    if (next) void load();
  };

  const clear = async () => {
    try {
      await aiClearUsageLog();
      setConfirmClear(false);
      await load();
    } catch (e) {
      logger.warn("清空 AI 用量明细失败", e);
    }
  };

  return (
    <div className={styles.advanced}>
      <button className={styles.advancedToggle} onClick={toggle}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        用量明细
        <span className={styles.advancedHint}>每次调用的 token 与花费，不含内容</span>
      </button>

      {!open ? null : loading && !stats ? (
        <div className={styles.usageNote}>
          <Loader2 size={12} className="spin" /> 加载中…
        </div>
      ) : (
        <div className={styles.advancedBody}>
          {stats && stats.totalCalls > 0 ? (
            <>
              {/* v6.4 汇总条：次数 / token / 缓存命中率 */}
              <div className={styles.sumGrid}>
                <div className={styles.sumItem}>
                  <b className={styles.sumNum}>{stats.totalCalls}</b>
                  <span className={styles.sumLabel}>近 {stats.days} 天调用</span>
                </div>
                <div className={styles.sumItem}>
                  <b className={styles.sumNum}>
                    {(stats.totalPromptTokens + stats.totalCompletionTokens) / 1000 >= 1
                      ? `${((stats.totalPromptTokens + stats.totalCompletionTokens) / 1000).toFixed(1)}k`
                      : stats.totalPromptTokens + stats.totalCompletionTokens}
                  </b>
                  <span className={styles.sumLabel}>token</span>
                </div>
                <div className={styles.sumItem}>
                  <b className={styles.sumNum}>{Math.round(stats.cacheHitRate * 100)}%</b>
                  <span className={styles.sumLabel}>缓存命中</span>
                </div>
              </div>

              {stats.byAction.length > 0 && (
                <div className={styles.logList}>
                  {stats.byAction.map((a) => (
                    <div key={a.actionId} className={styles.logRow}>
                      <span className={styles.logAction}>{labels[a.actionId] ?? a.actionId}</span>
                      <span className={styles.logMeta}>{a.calls} 次</span>
                      <span className={styles.logMeta}>
                        {a.promptTokens}+{a.completionTokens}
                      </span>
                      <span className={styles.logMeta}>¥{a.costCny.toFixed(3)}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className={styles.field}>
                <span className={styles.label}>最近 {rows.length} 次调用</span>
                {/* v6.4 表头 */}
                <div className={styles.logHead}>
                  <span className={styles.logHeadTime}>时间</span>
                  <span className={styles.logHeadAction}>动作</span>
                  <span className={styles.logHeadModel}>模型</span>
                  <span className={styles.logHeadTok}>token</span>
                  <span className={styles.logHeadRes}>结果</span>
                </div>
                <div className={styles.logList}>
                  {rows.map((r) => (
                    <div key={r.id} className={styles.logDetail}>
                      <span className={styles.logTime}>{shortTime(r.createdAt)}</span>
                      <span className={styles.logAction}>
                        {labels[r.actionId] ?? r.actionId}
                      </span>
                      <span className={styles.logModel} title={r.model}>
                        {r.model}
                      </span>
                      <span className={styles.logTok}>
                        {r.cached ? "—" : `${r.promptTokens}+${r.completionTokens}`}
                      </span>
                      {r.cached ? (
                        <span className={styles.tagCached}>缓存</span>
                      ) : !r.ok ? (
                        <span className={styles.tagFailed} title={r.error ?? ""}>
                          ✗
                        </span>
                      ) : (
                        <span className={styles.logCheck}>✓</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <span className={styles.usageNote}>还没有调用记录。</span>
          )}

          <div className={styles.row}>
            {confirmClear ? (
              <>
                <button className={settings.btnDanger} onClick={() => void clear()}>
                  确认清空
                </button>
                <button className={settings.btnSecondary} onClick={() => setConfirmClear(false)}>
                  取消
                </button>
              </>
            ) : (
              <button
                className={settings.btnSecondary}
                disabled={!stats || stats.totalCalls === 0}
                onClick={() => setConfirmClear(true)}
              >
                清空明细
              </button>
            )}
            <span className={styles.hint}>
              明细只存在本机，不上传；自动保留 90 天。
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
