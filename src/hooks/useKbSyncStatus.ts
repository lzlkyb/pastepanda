/**
 * useKbSyncStatus — 知识库同步状态快照（胶囊 / 浮层共用）。
 *
 * 数据与分级逻辑从 `KbSyncStatusBar` 抽出（规则 #11）：
 * UI 换成胶囊后若再抄一份「什么时候算 warn」，两边迟早分叉。
 *
 * 打扰分级（原注释保留）：
 *   已休眠            → 不出行
 *   从未成功、还在试   → info（你处理不了）
 *   曾经成功、现在连不上 → warn（值得看一眼）
 *   时钟偏差 / 冲突 / 没传完… → warn / bad
 */
import { useState, useCallback, useEffect } from "react";
import { create } from "zustand";
import { useWindowVisible } from "@/hooks/useWindowVisible";
import { logger } from "@/lib/logger";
import type { KbDevice, KbLastSync } from "@/hooks/useKbSync";
import { countKbOnline } from "@/lib/kbOnline";
import { explainSyncError } from "@/lib/syncError";

export type SyncAlertTone = "bad" | "warn" | "info";

export interface SyncAlert {
  key: string;
  tone: SyncAlertTone;
  title: string;
  detail?: string;
  /** 悬停看原始错误串（排错用） */
  rawError?: string;
  /** 点标题可执行的动作（如搜冲突） */
  action?: { label: string; run: () => void };
}

export interface KbSyncSnapshot {
  /** 无配对设备 / 同步关 → 不渲染入口 */
  visible: boolean;
  onlineCount: number;
  deviceCount: number;
  /** 胶囊短文案 */
  capText: string;
  /** 点：ok / warn / bad / 空=灰 */
  capTone: "ok" | "warn" | "bad" | "";
  /** 可处理项数量（warn+bad），用于角标 */
  actionableCount: number;
  /** 浮层标题行 */
  headTitle: string;
  headSub: string;
  alerts: SyncAlert[];
}

function ago(ms: number): string {
  const d = Date.now() - ms;
  if (d < 0) return "刚刚";
  if (d < 60_000) return `${Math.floor(d / 1000)} 秒前`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  return `${Math.floor(d / 86_400_000)} 天前`;
}

function mins(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

/** × 后本次会话不再提示。见原 KbSyncStatusBar 里「为何是 zustand」的注释。 */
interface DismissedState {
  dismissed: Record<string, boolean>;
  dismiss: (key: string) => void;
}
const useDismissed = create<DismissedState>((set) => ({
  dismissed: {},
  dismiss: (key) => set((s) => ({ dismissed: { ...s.dismissed, [key]: true } })),
}));

export function useKbSyncStatus(
  enabled: boolean,
  onSearchConflicts: () => void
): KbSyncSnapshot & { dismiss: (key: string) => void } {
  const [devices, setDevices] = useState<KbDevice[]>([]);
  const [live, setLive] = useState<string[]>([]);
  const [last, setLast] = useState<KbLastSync[]>([]);
  const [backlog, setBacklog] = useState(0);
  const dismissed = useDismissed((s) => s.dismissed);
  const dismiss = useDismissed.getState().dismiss;

  const refresh = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const r = await invoke<{
        devices: KbDevice[];
        live: string[];
        last: KbLastSync[];
        conflict_backlog: number;
      }>("kb_sync_devices");
      setDevices(r.devices);
      setLive(r.live);
      setLast(r.last);
      setBacklog(r.conflict_backlog);
    } catch (e) {
      logger.warn("读取同步状态失败", e);
    }
  }, []);

  const winVisible = useWindowVisible();
  useEffect(() => {
    if (!enabled || !winVisible) return;
    refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [enabled, winVisible, refresh]);

  if (!enabled || devices.length === 0) {
    return {
      visible: false,
      onlineCount: 0,
      deviceCount: 0,
      capText: "",
      capTone: "",
      actionableCount: 0,
      headTitle: "",
      headSub: "",
      alerts: [],
      dismiss,
    };
  }

  const name = (peer: string) =>
    devices.find((d) => d.node_id === peer)?.name ?? peer.slice(0, 8);
  const newest = last.find((l) => l.fails === 0 && l.at_ms > 0);
  const onlineCount = countKbOnline(devices, live);
  const skew = last.find((l) => l.clock_too_far_ahead_ms != null);
  const failing = last.filter((l) => l.fails > 0 && !l.dormant);
  const broke = failing.filter((l) => l.last_ok_ms > 0);
  const neverOk = failing.filter((l) => l.last_ok_ms === 0);
  const neverOkWhy = neverOk.length > 0 ? explainSyncError(neverOk[0].error) : null;
  const skipped = newest && newest.skipped_older > 0 ? newest : null;
  const live0 = last.filter((l) => l.fails === 0);
  const lostFiles = live0.reduce((a, l) => a + l.missing_files, 0);
  const failedImports = live0.reduce((a, l) => a + l.import_failed, 0);
  const assetsSkipped = live0.reduce((a, l) => a + l.assets_skipped, 0);
  const diverged = live0.reduce((a, l) => a + l.diverged_buckets, 0);

  const alerts: SyncAlert[] = [];

  if (skew) {
    alerts.push({
      key: "skew",
      tone: "bad",
      title: `${name(skew.peer)} 的系统时间比本机快 ${mins(skew.clock_too_far_ahead_ms!)}`,
      detail:
        "你在这台机器上改的笔记会一直判输——它的时间戳永远更大。请校准两台机器的系统时间，改完自动恢复。",
    });
  }
  if (backlog > 0) {
    alerts.push({
      key: "conflict",
      tone: "warn",
      title: `有 ${backlog} 处冲突副本还没处理`,
      detail: "两台设备在同一段时间里各改了同一篇。两个版本都留着了，没有丢。",
      action: { label: `查看这 ${backlog} 处 →`, run: onSearchConflicts },
    });
  }
  if (skipped) {
    alerts.push({
      key: "skipped",
      tone: "info",
      title: `最近一次有 ${skipped.skipped_older} 篇以本机版本为准`,
      detail: "对端那几篇更旧、已跳过。",
    });
  }
  if (lostFiles > 0) {
    alerts.push({
      key: "truncated",
      tone: "warn",
      title: `有 ${lostFiles} 篇没传完`,
      detail: "清单里说有、文件却没到，通常是网络抖了一下。下一轮会自动重来。",
    });
  }
  if (failedImports > 0) {
    alerts.push({
      key: "import-failed",
      tone: "warn",
      title: `有 ${failedImports} 篇没能存进来`,
      detail: "文件收到了，但写入失败——最常见的原因是单篇太大（超过 10MB）。同步会一直重试。",
    });
  }
  if (diverged > 0) {
    alerts.push({
      key: "diverged",
      tone: "info",
      title: `最近一次对账发现 ${diverged} 处两边对不上，已重同步`,
      detail: "没有丢东西。如果这条一直出现，说明没修好——那是个 bug。",
    });
  }
  if (assetsSkipped > 0) {
    alerts.push({
      key: "assets-skipped",
      tone: "warn",
      title: `有 ${assetsSkipped} 张图没发出去`,
      detail:
        "对方那边这几张会显示成断图。要么是原图已不在本机，要么是单张超过 10MB。只有这台看得见。",
    });
  }
  for (const f of broke) {
    const why = explainSyncError(f.error);
    alerts.push({
      key: `fail-${f.peer}`,
      tone: "warn",
      title: `连不上 ${name(f.peer)}（${ago(f.last_ok_ms)}还好好的）`,
      detail: `${f.next_in_secs} 秒后重试。对方可能刚关机、换了网络，或关了这个开关。${why ? `（${why}）` : ""}`,
      rawError: f.error ?? undefined,
    });
  }
  if (neverOk.length > 0) {
    alerts.push({
      key: "fail-new",
      tone: "info",
      title: `还没连上 ${neverOk.length} 台（${neverOk.map((f) => name(f.peer)).join("、")}）`,
      detail: `还在重试。${neverOkWhy ? `（${neverOkWhy}）` : ""}`,
      rawError: neverOk[0].error ?? undefined,
    });
  }

  const shown = alerts.filter((a) => !dismissed[a.key]);
  const actionable = shown.filter((a) => a.tone === "warn" || a.tone === "bad");

  let capTone: KbSyncSnapshot["capTone"] = "";
  let capText: string;
  if (actionable.length > 0) {
    capTone = actionable.some((a) => a.tone === "bad") ? "bad" : "warn";
    // 角标已写数量，文案不再重复「N 项」——否则胶囊过长挤扁面包屑
    capText = newest ? "已同步 · 待看" : `配对 ${devices.length} 台 · 待看`;
  } else if (newest) {
    capTone = "ok";
    capText = `已同步 · ${ago(newest.at_ms)}`;
  } else {
    capText =
      onlineCount > 0
        ? `配对 ${devices.length} 台 · 等下一轮`
        : `配对 ${devices.length} 台 · 离线`;
  }

  const headTitle = newest
    ? `已与 ${name(newest.peer)} 同步 · ${ago(newest.at_ms)}`
    : `已配对 ${devices.length} 台`;
  const headSub =
    newest && newest.next_in_secs > 0
      ? `下次约 ${newest.next_in_secs} 秒后`
      : onlineCount > 0
        ? "正在等下一轮同步"
        : "对方都不在线 · 约 10 秒刷新";

  return {
    visible: true,
    onlineCount,
    deviceCount: devices.length,
    capText,
    capTone,
    actionableCount: actionable.length,
    headTitle,
    headSub,
    alerts: shown,
    dismiss,
  };
}
