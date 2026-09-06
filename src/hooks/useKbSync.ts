import { useState, useCallback, useEffect, useRef } from "react";
import { useWindowVisible } from "@/hooks/useWindowVisible";
import { logger } from "@/lib/logger";

/** 后端 `data_store::device::Device`。字段名保持与 Rust 一致，别在这层改名。 */
export interface KbDevice {
  node_id: string;
  name: string;
  paired_at: string;
  /** `lan` / `wan` / `""`（还没连上过） */
  transport: string;
  /** `online` / `offline` */
  conn_state: string;
  /** 最近一次成功握手的 epoch 毫秒；0 = 从未 */
  last_seen: number;
  relay_addr: string;
  sync_cursor_ms: number;
}

/** 后端 `sync::service::LastSync`。 */
export interface KbLastSync {
  peer: string;
  at_ms: number;
  created: number;
  updated: number;
  deleted: number;
  /** 后写胜里输掉的那一边的条数——那个静默丢弃的**唯一痕迹**。 */
  skipped_older: number;
  conflicts: number;
  /** 清单说有、文件却没到（传输被截断）。 */
  missing_files: number;
  /** 文件到了但写不进库（如超过单篇导入上限）。与 `missing_files` 同等对待。 */
  import_failed: number;
  /** 非 null = 本机之后赢不过那台机器。 */
  clock_too_far_ahead_ms: number | null;
  /** 连续失败次数；0 = 上一次成功。 */
  fails: number;
  error: string | null;
  /** 大约多久后再试 / 再同步（秒）。**含拖动，界面上别写死。** */
  next_in_secs: number;
}

export interface KbIdentity {
  node_id: string;
  /** 给人肉眼核对的 16 个字符，4-4-4-4 */
  fingerprint: string;
  running: boolean;
  /**
   * 本机计算机名，配对向导拿它当设备名默认值。
   * **可能是空串**（后端取不到 hostname 时故意留空，见 `kb_sync.rs`）。
   */
  device_name: string;
}

/** `kb_sync_invite_create` 的返回。 */
export interface KbInviteCreated {
  code: string;
  /** 过期时刻（epoch 毫秒）。后端算好的——前端别拿 TTL 再推一遍。 */
  expires_at: number;
}

/** 邀请码解出来的内容（`sync::invite::Invite`）。 */
export interface KbInvite {
  node_id: string;
  name: string;
  addrs: string[];
  ts: number;
}

/**
 * 正拿着本机发出的邀请在敲门、等用户确认的对端（`sync::join::JoinRequest`）。
 *
 * ❗ **没有设备名**，只有 `node_id`。这是后端故意的：设备名是可自称的，
 * 而指纹绑在已认证的连接身份上。界面上用 `fingerprintOf(node_id)` 算指纹，
 * 与对方机器上「本机指纹」显示的是同一串。详见 `sync/join.rs` 模块注释。
 */
export interface KbJoinRequest {
  node_id: string;
  first_seen_ms: number;
  last_seen_ms: number;
  /** 敲了几次。给界面看「它一直在试」。 */
  tries: number;
}

/**
 * 知识库同步的命令收口（规则 #11）。
 *
 * ❗ 轮询用 `useWindowVisible` 门住：窗口 `hide()` 之后 WebView 还活着，
 * 空转会烧 CPU（规则 #8）。这条是照 `LanSyncPanel` 的先例。
 *
 * ❗ 失败提示只在「从成功转失败」那一次弹：5 秒轮询下持续失败会刷屏 toast，
 * 同样是 `LanSyncPanel` 踩过的。
 */
export function useKbSync(enabled: boolean, toast: (m: string, t?: "success" | "error" | "info") => void) {
  const [identity, setIdentity] = useState<KbIdentity | null>(null);
  const [devices, setDevices] = useState<KbDevice[]>([]);
  const [live, setLive] = useState<string[]>([]);
  const [last, setLast] = useState<KbLastSync[]>([]);
  const [backlog, setBacklog] = useState(0);
  /** 待本机确认的敲门。空数组 = 没人在等。 */
  const [pending, setPending] = useState<KbJoinRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const wasOkRef = useRef(true);

  const call = useCallback(async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }, []);

  /** 身份与开关关着时也要能读——用户得先把指纹给对方看。 */
  const refreshIdentity = useCallback(async () => {
    try {
      setIdentity(await call<KbIdentity>("kb_sync_identity"));
    } catch (e) {
      logger.warn("读取同步身份失败", e);
      toast(`读取本机指纹失败：${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }, [call, toast]);

  const refreshDevices = useCallback(async () => {
    try {
      const r = await call<{
        devices: KbDevice[]; live: string[]; last: KbLastSync[]; conflict_backlog: number;
        pending: KbJoinRequest[];
      }>("kb_sync_devices");
      setDevices(r.devices);
      setLive(r.live);
      setLast(r.last);
      setBacklog(r.conflict_backlog);
      // 后端把它搭在同一个命令里，所以不多一次往返，也不会两边快照对不上。
      setPending(r.pending ?? []);
      wasOkRef.current = true;
    } catch (e) {
      logger.warn("读取已配对设备失败", e);
      if (wasOkRef.current) {
        toast(`读取设备列表失败：${e instanceof Error ? e.message : String(e)}`, "error");
      }
      wasOkRef.current = false;
    }
  }, [call, toast]);

  const winVisible = useWindowVisible();
  useEffect(() => {
    if (!enabled || !winVisible) return;
    refreshDevices();
    const t = setInterval(refreshDevices, 5000);
    return () => clearInterval(t);
  }, [enabled, winVisible, refreshDevices]);

  useEffect(() => {
    refreshIdentity();
  }, [refreshIdentity]);

  const createInvite = useCallback(async (name: string) => {
    setBusy(true);
    try {
      return await call<KbInviteCreated>("kb_sync_invite_create", { name });
    } finally { setBusy(false); }
  }, [call]);

  /** 只解码不配对。给「核对指纹」那一步用——**配对前必须先让用户看到对方指纹**。 */
  const previewInvite = useCallback(
    (code: string) => call<KbInvite>("kb_sync_invite_preview", { code }),
    [call],
  );

  const pair = useCallback(async (code: string) => {
    setBusy(true);
    try {
      const inv = await call<KbInvite>("kb_sync_pair", { code });
      await refreshDevices();
      return inv;
    } finally { setBusy(false); }
  }, [call, refreshDevices]);

  const forget = useCallback(async (nodeId: string) => {
    setBusy(true);
    try {
      await call<boolean>("kb_sync_forget", { nodeId });
      await refreshDevices();
    } finally { setBusy(false); }
  }, [call, refreshDevices]);

  /**
   * 放行一条敲门（用户已核对两边指纹）。
   *
   * 🔴 这是**生成方**那一半的配对。以前只有粘贴方会写设备表，
   * 生成方把对方每一次连接都拒掉——两台机器从来没连通过。
   */
  const approveJoin = useCallback(async (nodeId: string, name: string) => {
    setBusy(true);
    try {
      await call<void>("kb_sync_join_approve", { nodeId, name });
      await refreshDevices();
    } finally { setBusy(false); }
  }, [call, refreshDevices]);

  /** 拒绝一条敲门。本次进程内不再为它弹。 */
  const denyJoin = useCallback(async (nodeId: string) => {
    setBusy(true);
    try {
      await call<void>("kb_sync_join_deny", { nodeId });
      await refreshDevices();
    } finally { setBusy(false); }
  }, [call, refreshDevices]);

  const syncNow = useCallback(async (nodeId: string) => {
    setBusy(true);
    try {
      await call<void>("kb_sync_now", { nodeId });
      await refreshDevices();
      toast("同步完成", "success");
    } catch (e) {
      // 不静默（规则 #15.3）：这个按钮就是用来诊断同步不通的，静默失败最讽刺
      toast(`同步失败：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally { setBusy(false); }
  }, [call, refreshDevices, toast]);

  return {
    identity, devices, live, last, backlog, pending, busy,
    refreshIdentity, refreshDevices,
    createInvite, previewInvite, pair, forget, syncNow,
    approveJoin, denyJoin,
  };
}
