import { useState, useEffect, useMemo, useCallback } from "react";
import type { AppConfig } from "@/stores/appStore";
import type { StatsDetail } from "@/lib/api";
import { chainList, type ChainDef } from "@/lib/api/chains";
import { resolveSource } from "@/lib/source-mappings";
import { useToast } from "@/components/Toast";
import { logger } from "@/lib/logger";
/** .md 关联状态以系统注册表为准，不落 AppConfig（避免设置与注册表脱节） */
export type MdAssocStatus = "unregistered" | "registered" | "default";

interface UseSettingsDataParams {
  config: AppConfig;
  updateAndSave: (partial: Record<string, unknown>) => Promise<void>;
  stats: StatsDetail | null;
}

/**
 * 设置页各分区共用的状态与副作用。
 *
 * 从 GeneralTab.tsx 原样搬出，逻辑未做任何改动——目的只是让后续把分区拆成
 * 独立文件时，这些跨分区共享的东西有个明确的归属地，而不是继续堆在
 * GeneralTab 顶部 200 行里。
 */
export function useSettingsData({ config, updateAndSave, stats }: UseSettingsDataParams) {
  const { toast } = useToast();

  const cleanupDays = config.auto_cleanup_days;
  // 修复：改保留天数原本点即生效，下一小时静默删一批且自动清理不写撤销栈（见 auto_cleanup.rs）。
  // 变严格时先用已有的 count_expired_history 算出影响条数，弹二次确认（与手动清理同一套模式）。
  // count 为 null 表示统计失败：仍然弹确认（不能因统计失败就静默删），只是不显示具体条数
  const [pendingCleanup, setPendingCleanup] = useState<{ days: number; count: number | null } | null>(null);

  const handlePickCleanupDays = useCallback(async (next: number) => {
    if (next === cleanupDays) return;
    // 关闭清理或把天数改大（变宽松）不会产生新的删除，直接生效
    if (next <= 0 || (cleanupDays > 0 && next > cleanupDays)) {
      await updateAndSave({ auto_cleanup_days: next });
      return;
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const n = await invoke<number>("count_expired_history", {
        workspace: config.current_workspace,
        beforeDays: next,
      });
      if (n > 0) { setPendingCleanup({ days: next, count: n }); return; }
      // 新天数下没有任何记录会被删，无需骚扰用户
      await updateAndSave({ auto_cleanup_days: next });
    } catch (e) {
      logger.warn("统计过期记录数失败", e);
      setPendingCleanup({ days: next, count: null });
    }
  }, [cleanupDays, config.current_workspace, updateAndSave]);

  // 回收站保留天数（W1 / R3）。**与上面那个是两回事**：那个管「没沉淀过的
  // 剪贴板流水」，这个管「用户亲手删的笔记」——把历史设成 7 天的人不是在说
  // 删的笔记也只给 7 天，所以不能共用一个配置项。
  const trashDays = config.note_trash_days;
  const [pendingTrash, setPendingTrash] = useState<{ days: number; count: number | null } | null>(null);

  // 同上面的口径：变宽松（关掉 / 改大）不会产生新的删除，直接生效；
  // 变严格先拿真数字弹二次确认。不这么做就是重犯剪贴板那边修过的同一个 bug
  // （「点即生效，下一小时静默删一批」）——而这边删的是笔记，更痛。
  const handlePickTrashDays = useCallback(async (next: number) => {
    if (next === trashDays) return;
    if (next <= 0 || (trashDays > 0 && next > trashDays)) {
      await updateAndSave({ note_trash_days: next });
      return;
    }
    const { noteCountExpired } = await import("@/lib/api/notes");
    const n = await noteCountExpired(next);
    // n === null 是统计失败：照弹确认，只是不报具体条数。
    // 不能因为统计失败就静默改——那正好把安全网拆了。
    if (n === 0) {
      await updateAndSave({ note_trash_days: next });
      return;
    }
    setPendingTrash({ days: next, count: n });
  }, [trashDays, updateAndSave]);

  // 深度清理弹窗开关（数据管理 → 深度清理）
  const [showDeepClean, setShowDeepClean] = useState(false);

  // v6.4 E 剪贴板周报弹窗开关
  const [showWeekReport, setShowWeekReport] = useState(false);

  // ── 数据仪表盘：来源 Top 5 折叠状态 + 更新时间 + 派生指标 ──
  const [srcOpen, setSrcOpen] = useState(false);
  const [loadedAt, setLoadedAt] = useState("");
  // V6.19：截图默认动作链下拉的链列表
  const [chains, setChains] = useState<ChainDef[]>([]);
  useEffect(() => {
    void chainList().then(setChains).catch((e) => logger.warn("动作链列表加载失败", e));
  }, []);
  useEffect(() => {
    if (stats) {
      const d = new Date();
      setLoadedAt(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`);
    }
  }, [stats]);

  /** 仪表盘派生值：今昨涨跌、7 日均、时段峰值、圆环弧长、来源摘要等 */
  const dash = useMemo(() => {
    if (!stats) return null;
    const dailyMax = Math.max(1, ...stats.daily.map((d) => d.count));
    const weekTotal = stats.daily.reduce((s, d) => s + d.count, 0);
    const weekAvg = Math.round(weekTotal / 7);
    const delta =
      stats.yesterday > 0
        ? {
            text: `${stats.today >= stats.yesterday ? "▲" : "▼"} ${Math.abs(((stats.today - stats.yesterday) / stats.yesterday) * 100).toFixed(1)}%`,
            up: stats.today >= stats.yesterday,
          }
        : stats.today > 0
          ? { text: "新增", up: true }
          : null;
    const hourMax = Math.max(...stats.hours);
    const peakHour = hourMax > 0 ? stats.hours.indexOf(hourMax) : -1;
    const typeTotal = stats.text_count + stats.image_count + stats.file_count;
    const C = 2 * Math.PI * 30; // 圆环周长（r=30）
    const arc = (n: number) => (typeTotal > 0 ? (n / typeTotal) * C : 0);
    const textArc = arc(stats.text_count);
    const imageArc = arc(stats.image_count);
    const fileArc = arc(stats.file_count);
    const textPct = typeTotal > 0 ? Math.round((stats.text_count / typeTotal) * 100) : 0;
    const top = stats.sources[0];
    const srcSummary =
      top && stats.total > 0
        ? `${resolveSource(top.source).displayName} ${Math.round((top.count / stats.total) * 100)}% 居首`
        : "";
    const srcMax = top ? Math.max(1, top.count) : 1;
    return { dailyMax, weekTotal, weekAvg, delta, hourMax, peakHour, C, textArc, imageArc, fileArc, textPct, srcSummary, srcMax };
  }, [stats]);

  // ── .md 文件关联：状态以系统注册表为准（实时查询，不存 AppConfig，避免设置与注册表脱节） ──
  const [mdAssoc, setMdAssoc] = useState<MdAssocStatus | "loading">("loading");
  const [mdAssocBusy, setMdAssocBusy] = useState(false);

  const refreshMdAssoc = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const s = await invoke<string>("get_md_association_status");
      if (s === "default" || s === "registered" || s === "unregistered") setMdAssoc(s);
    } catch {
      /* 查询失败保持当前状态 */
    }
  }, []);

  useEffect(() => { void refreshMdAssoc(); }, [refreshMdAssoc]);
  // 用户去系统设置确认后返回，窗口重新获焦时自动刷新状态
  useEffect(() => {
    const onFocus = () => void refreshMdAssoc();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshMdAssoc]);

  const handleMdAssocToggle = useCallback(async (enable: boolean) => {
    if (mdAssocBusy) return;
    setMdAssocBusy(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_md_association", { enable });
      toast(enable ? "已注册 .md 打开方式，请在设置页中点击 .md 一行并选择 PastePanda" : "已取消 .md 文件关联", "success");
      await refreshMdAssoc();
    } catch (e) {
      logger.warn("设置 .md 关联失败", e);
      toast(".md 文件关联设置失败", "error");
    } finally {
      setMdAssocBusy(false);
    }
  }, [mdAssocBusy, refreshMdAssoc, toast]);

  return {
    cleanupDays, pendingCleanup, setPendingCleanup, handlePickCleanupDays,
    trashDays, pendingTrash, setPendingTrash, handlePickTrashDays,
    showDeepClean, setShowDeepClean,
    showWeekReport, setShowWeekReport,
    srcOpen, setSrcOpen,
    loadedAt, chains, dash,
    mdAssoc, mdAssocBusy, handleMdAssocToggle,
  };
}

/** 分区组件声明 props 时直接索引这个类型（如 SettingsData["dash"]），不要手抄形状 */
export type SettingsData = ReturnType<typeof useSettingsData>;
