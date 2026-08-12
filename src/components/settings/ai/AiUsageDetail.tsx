/**
 * 用量明细（默认折叠，展开才拉数据）。
 *
 * **这里看不到任何内容文本**，因为后端的 `ai_usage_log` 表里根本没那个字段。
 * 只有时间、动作、模型、token 数与成败。
 *
 * 自己拉数据而不是由 AiTab 传：大部分人永远不会展开它，没必要每次打开
 * 设置面板都去查三次库。
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
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

/**
 * 本组件只渲染**内容**，外壳由 AiTab 里的 AiSection 提供（方案 B）。
 *
 * 注意一个前提：AiSection 折叠时**不渲染 children**，所以对本组件而言
 * “挂载”就等于“展开”、“收起”就是真的卸载。因此：
 *   · 不需要 open 参数（挂载时它永远是 true）
 *   · 也无法做“首次展开后复用”——任何 ref/state 都会随卸载销毁
 */
export function AiUsageDetail() {
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<AiUsageStats | null>(null);
  const [rows, setRows] = useState<AiUsageLogRow[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>(EXTRA_LABELS);
  const [confirmClear, setConfirmClear] = useState(false);
  /** v6.4 审查：#6 加载失败与空态区分 */
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
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
      setLoadFailed(true);
      logger.warn("加载 AI 用量明细失败", e);
    } finally {
      setLoading(false);
    }
  }, []);

  // 挂载即加载（= 展开即加载）。
  //
  // 此前这里有一个 loadedOnce ref 做“首次展开后复用、反复开关不重复拉 4 个命令”，
  // 但在折叠会卸载组件的前提下它根本不生效（ref 随卸载销毁），
  // 留着只是个假象。删掉而不是假装还在优化：现在每次展开都重新拉一次，
  // 代价是多四个本地命令，好处是看到的数据总是新的。
  // （“确认清空”的危险态也由卸载自动重置，不用手动清。）
  useEffect(() => {
    void load();
  }, [load]);

  const clear = async () => {
    try {
      await aiClearUsageLog();
      setConfirmClear(false);
      await load();
    } catch (e) {
      // 审查：清空失败要给用户提示（此前仅 warn，用户点了确认后静默失败）
      logger.warn("清空 AI 用量明细失败", e);
      window.dispatchEvent(
        new CustomEvent("app-toast", {
          detail: { message: "清空用量明细失败，请重试", type: "error" },
        })
      );
    }
  };

  return (
    <div className={styles.advancedBody}>
      {loading && !stats ? (
        <div className={styles.usageNote}>
          <Loader2 size={12} className="spin" /> 加载中…
        </div>
      ) : loadFailed ? (
        /* v6.4 审查：#6 失败≠空态 */
        <div className={styles.row} style={{ padding: "6px 12px" }}>
          <span className={styles.hint}>加载失败，请重试。</span>
          <button className={settings.btnSecondary} onClick={() => void load()}>
            重试
          </button>
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
                {/* v6.4 表头；审查：无记录时隐藏表头（空列表不摆空表头） */}
                {rows.length > 0 && (
                <div className={styles.logHead}>
                  <span className={styles.logHeadTime}>时间</span>
                  <span className={styles.logHeadAction}>动作</span>
                  <span className={styles.logHeadModel}>模型</span>
                  <span className={styles.logHeadTok}>token</span>
                  <span className={styles.logHeadRes}>结果</span>
                </div>
                )}
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
