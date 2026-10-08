import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { KbDevice, KbLastSync } from "@/hooks/useKbSync";
import type { MobileFeedback } from "../ui/MobileNotice";

type Offer = { node_id: string; name: string; paired_at: string };
type Snapshot = { devices: KbDevice[]; last: KbLastSync[]; conflict_backlog: number };
const EMPTY: Snapshot = { devices: [], last: [], conflict_backlog: 0 };

export function useKnowledgeSync(active: boolean, onChanged?: () => void) {
  const [snapshot, setSnapshot] = useState(EMPTY);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState("");
  const [syncingPeer, setSyncingPeer] = useState("");
  const [feedback, setFeedback] = useState<MobileFeedback | null>(null);
  const mounted = useRef(true);
  const flight = useRef<Promise<Snapshot> | null>(null);
  const action = useRef("");
  const epoch = useRef(0);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const previous = useRef("");
  const available = useRef<Offer[]>([]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = useCallback(() => {
    if (flight.current) return flight.current;
    const request = Promise.all([
      invoke<Snapshot>("kb_sync_devices"),
      invoke<Offer[]>("rc_sync_offers"),
      invoke<boolean>("get_kb_sync_status"),
    ])
      .then(([next, candidates, isEnabled]) => {
        available.current = candidates;
        if (mounted.current) {
          setSnapshot(next);
          setOffers(candidates);
          setEnabled(isEnabled);
          setReady(true);
          setFeedback((current) => current?.title === "同步状态暂时无法读取" ? null : current);
          // Reports describe a peer round, never a per-note delivery receipt.
          const signature = JSON.stringify(next.last.map((r) => [r.peer, r.at_ms, r.created, r.updated, r.deleted]));
          if (previous.current && signature !== previous.current) changed.current?.();
          previous.current = signature;
        }
        return next;
      })
      .finally(() => {
        if (flight.current === request) flight.current = null;
      });
    flight.current = request;
    return request;
  }, []);
  const refreshFresh = useCallback(async () => {
    if (flight.current) {
      try {
        await flight.current;
      } catch {
        /* Read again after a stale request. */
      }
    }
    return refresh();
  }, [refresh]);

  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const read = () => {
      if (action.current) return;
      void refresh().catch(() => {
        if (mounted.current && !action.current) {
          setReady(false);
          setFeedback({
            tone: "warning",
            title: "同步状态暂时无法读取",
            detail: "本机笔记仍可阅读和保存，打开同步面板后可重试。",
          });
        }
      });
    };
    const visible = () => {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      if (document.hidden) return;
      read();
      // LastSync has no event source. One low-frequency reader owns polling.
      timer = setInterval(read, 15000);
    };
    visible();
    document.addEventListener("visibilitychange", visible);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [active, refresh]);

  const run = useCallback(
    async (name: string, title: string, work: () => Promise<MobileFeedback>) => {
      if (action.current) return false;
      action.current = name;
      const id = ++epoch.current;
      setBusy(name);
      setFeedback({ tone: "pending", title });
      try {
        const result = await work();
        if (mounted.current && id === epoch.current) setFeedback(result);
        return true;
      } catch {
        if (mounted.current && id === epoch.current)
          setFeedback({
            tone: "error",
            title: name === "authorize" ? "授权或同步启动未全部完成" : "操作未能完成",
            detail:
              name === "authorize"
                ? "授权可能已经写入，下面的设备列表会重新核对。请检查电脑确认请求，再重试同步；不要重复添加。"
                : "本机内容已保留。请检查电脑的知识库同步开关和授权，再重试。",
          });
        return false;
      } finally {
        try {
          await refreshFresh();
        } catch {
          /* Operation feedback remains visible. */
        }
        if (mounted.current && id === epoch.current) {
          action.current = "";
          setBusy("");
        }
      }
    },
    [refreshFresh],
  );

  const authorize = (offer: Offer) =>
    run("authorize", "正在保存知识库授权…", async () => {
      const latest = await refreshFresh();
      // Current protocol has no library identity. Do not silently merge another PC.
      if (latest.devices.some((d) => d.node_id !== offer.node_id)) throw new Error("multiple-library");
      if (!latest.devices.some((d) => d.node_id === offer.node_id)) {
      if (!available.current.some(candidate => candidate.node_id === offer.node_id)) throw new Error("rc-device-removed");
        await invoke("kb_sync_allow_from_rc", { nodeId: offer.node_id, name: offer.name });
      }
      await invoke("toggle_kb_sync", { enable: true });
      return {
        tone: "info",
        title: "已授权并开启同步",
        detail: "等待电脑确认本手机；整个当前知识库会双向同步，本机内容也会传到电脑。",
      };
    });

  const toggle = (enable: boolean) =>
    run("toggle", enable ? "正在开启同步…" : "正在关闭同步…", async () => {
      await invoke("toggle_kb_sync", { enable });
      return {
        tone: "info",
        title: enable ? "同步已开启" : "同步已关闭",
        detail: "本机笔记与草稿保留，可以继续使用。",
      };
    });
  const pause = (device: KbDevice) =>
    run("pause", "正在更新同步状态…", async () => {
      const ok = await invoke<boolean>("kb_sync_set_paused", { nodeId: device.node_id, paused: !device.paused });
      if (!ok) throw new Error("device-removed");
      return {
        tone: "info",
        title: device.paused ? "已恢复同步" : "已取消并暂停同步",
        detail: "已落盘笔记与草稿保留，不撤回已经传到电脑的内容。",
      };
    });
  const cancel = async (device: KbDevice) => {
    if (action.current !== "sync" || device.node_id !== syncingPeer) return false;
    const id = ++epoch.current;
    action.current = "cancel";
    setBusy("cancel");
    setFeedback({ tone: "pending", title: "正在取消同步…" });
    try {
      if (!(await invoke<boolean>("kb_sync_set_paused", { nodeId: device.node_id, paused: true })))
        throw new Error("removed");
      if (mounted.current && id === epoch.current)
        setFeedback({
          tone: "info",
          title: "已取消并暂停同步",
          detail: "已落盘笔记与草稿保留，可以继续阅读；需要时恢复同步。",
        });
      return true;
    } catch {
      if (mounted.current && id === epoch.current)
        setFeedback({ tone: "error", title: "未能取消同步", detail: "请重试，或关闭同步。已落盘笔记与草稿保留。" });
      return false;
    } finally {
      try {
        await refreshFresh();
      } catch {
        /* Keep cancellation result. */
      }
      if (mounted.current && id === epoch.current) {
        action.current = "";
        setBusy("");
      }
    }
  };
  const revoke = (device: KbDevice) =>
    run("revoke", "正在撤销知识库授权…", async () => {
      await invoke("kb_sync_forget", { nodeId: device.node_id });
      return {
        tone: "info",
        title: "知识库授权已撤销",
        detail: "本机笔记与草稿保留。已经存到电脑的内容不会被远程删除，远控配对不受影响。",
      };
    });
  const retry = () =>
    run("refresh", "正在刷新同步状态…", async () => {
      await invoke("kb_sync_refresh");
      await refreshFresh();
      return { tone: "info", title: "同步状态已刷新", detail: "刷新不代表资料已经同步完成。" };
    });
  const sync = (device: KbDevice) => {
    if (action.current) return Promise.resolve(false);
    setSyncingPeer(device.node_id);
    return run("sync", "正在与电脑同步…", async () => {
      const before = (await refreshFresh()).last.find((r) => r.peer === device.node_id)?.at_ms ?? 0;
      try {
        await invoke("kb_sync_now", { nodeId: device.node_id });
      } catch (error) {
        if (String(error).includes("本轮尚未完成"))
          return { tone: "info", title: "已有同步正在进行", detail: "请稍后查看设备报告，不重复发起同步。" };
        throw error;
      }
      const report = (await refreshFresh()).last.find((r) => r.peer === device.node_id);
      if (!report || report.at_ms <= before || report.fails > 0) {
        return {
          tone: "info",
          title: "同步请求已处理",
          detail: "尚未取得本轮成功报告。电脑可能正在向手机同步，请稍后查看状态。",
        };
      }
      if (
        report.missing_files ||
        report.import_failed ||
        report.assets_skipped ||
        report.conflicts ||
        report.skipped_older ||
        report.clock_too_far_ahead_ms
      ) {
        return {
          tone: "warning",
          title: "本轮同步有待处理项目",
          detail: "请查看设备下方报告。缺失与导入失败的内容不能视为完整离线资料。",
        };
      }
      return {
        tone: "success",
        title: "本轮同步已完成",
        detail: "这是设备级同步报告，不代表每篇笔记都有电脑落盘回执。",
      };
    });
  };
  return {
    ...snapshot,
    offers,
    enabled,
    ready,
    busy,
    syncingPeer,
    feedback,
    dismissFeedback: () => { if (!action.current) setFeedback(null); },
    authorize,
    toggle,
    pause,
    cancel,
    revoke,
    retry,
    sync,
  };
}
