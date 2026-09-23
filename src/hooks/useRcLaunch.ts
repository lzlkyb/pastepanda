/**
 * useRcLaunch — 工作台「发起远程」这条链路的记忆与动作（从 RcWorkbench 抽出）。
 *
 * 四样东西是一体的，分开放容易各写各的：
 * - `cap`：这次发起用哪一档能力，初值取上次成功用过的那档（`lib/rcRequest`）。
 *   主按钮 tooltip 会写明「将以 X 发起」，所以它必须真的是用户上次的选择。
 * - `lastAttempt`：**刚才点了哪台**。失败重试要能回到同一台。
 * - `lastPeer`：**成功连过哪台**。设备列表拿它在那一行打「最近」标记、空闲态也用它。
 * - **撤销窗口（D1）**：发起成功后给 6 秒撤回的机会。
 *
 * 🔴 只有成功才写记忆。失败也写的话，下次打开工作台会默认对准一台连不上的机器，
 *    而且 tooltip 会拿用户从没成功过的档来承诺。
 *
 * 抽出来的直接原因是 `RcWorkbench.tsx` 撞了 `.tsx ≤ 300` 红线（当时 301 行）。
 */
import { useEffect, useRef, useState } from "react";
import type { RcCapability } from "@/lib/api/rc";
import type { ToastFn } from "@/components/Toast";
import { UNDO_WINDOW_MS } from "@/components/Toast";
import { fingerprintOf } from "@/lib/fingerprint";
import type { UseRc } from "@/hooks/useRc";
import { capabilityLabel, lastRequestCap, rememberRequestCap } from "@/lib/rcRequest";
import { rcDisplayName } from "@/lib/rcDevice";

const LS_LAST = "rc_last_peer";
const LS_DEVICE_CAPS = "rc_device_caps";

export function useRcLaunch(rc: UseRc, toast: ToastFn) {
  const [cap, setCap] = useState<RcCapability>(() => lastRequestCap());
  /**
   * 按设备记忆的发起档（2026-09-23）：行内 ⌄ 菜单给某台选过档后只记那一台的，
   * 不再改写全局 `cap`——原先成功后 setCap(c) 会让所有设备行的主按钮和
   * 菜单默认标记一起变（用户实测：给一台选「只看」，列表全部变「只看」）。
   * 全局 `cap` 现在只由设置页「默认发起方式」（setDefaultCap）改写，
   * 作为没有按设备记忆时的兜底档。`capOf` 是唯一取值口。
   */
  const [deviceCaps, setDeviceCaps] = useState<Record<string, RcCapability>>({});
  const [lastAttempt, setLastAttempt] = useState<string | null>(null);
  const [lastPeer, setLastPeer] = useState<string | null>(null);

  /**
   * 撤销窗口要在**回调真的执行那一刻**判断「现在还在等对方点头吗」。
   * `rc` 是每次渲染新建的普通对象，而撤销回调最多 6 秒后才跑 —— 直接闭包捕获
   * 会把它冻在「点击那一帧」的 status 上（那时必然是 pending，判断永远为真）。
   * 读 ref 才是活的。用 effect 更新而不是渲染期赋值：渲染期写 ref 是被 React
   * 明确劝退的（并发渲染下可能写进被丢弃的那次渲染）。
   */
  const statusRef = useRef(rc.status);
  useEffect(() => {
    statusRef.current = rc.status;
  }, [rc.status]);

  // 上次成功连过的设备只存在 localStorage（后端没有「最近连接」这张表）。
  useEffect(() => {
    try {
      setLastPeer(localStorage.getItem(LS_LAST));
    } catch {
      /* ignore：隐私模式下 localStorage 会抛，退化成「没有上次」 */
    }
    try {
      const raw = localStorage.getItem(LS_DEVICE_CAPS);
      if (raw) setDeviceCaps(JSON.parse(raw) as Record<string, RcCapability>);
    } catch {
      /* ignore：坏数据当作没有按设备记忆 */
    }
  }, []);

  /** 某台设备的发起档：按设备记忆优先，没有则落全局默认档。唯一取值口。 */
  const capOf = (id: string): RcCapability => deviceCaps[id] ?? cap;

  /** 显示名与设备行同口径：走 `rcDisplayName`（统一显示名收口，备注优先）。 */
  const nameOf = (id: string) => {
    const t = rc.targets.find((x) => x.node_id === id);
    return t ? rcDisplayName(t, fingerprintOf(id)) : fingerprintOf(id);
  };

  /**
   * 撤销条：U4.2 的 6 秒窗口 + 一个「撤销」按钮。
   *
   * `toast` 的位置参数已经排到第 8 位，这里包一层，免得调用点写一串 `undefined`
   * 还要数位置（数错就是「撤销按钮点了没反应」或「渲染成重试图标」）。
   */
  const undoToast = (message: string, onUndo: () => void) =>
    toast(message, "info", UNDO_WINDOW_MS, undefined, undefined, undefined, undefined, onUndo);

  /**
   * 撤回刚发出的远程申请（D1）。
   *
   * 🔴 必须先确认**还在等对方点头**：后端 `rc_cancel_request` 的实现就是
   *    `svc.end_session("用户取消申请")` —— 它不看阶段。若对方在 6 秒窗口内点了同意，
   *    这一下就成了「把刚连上的会话关掉」，与「撤销申请」的心智完全不符。
   *    所以非 `outbound_pending` 一律不撤回，只如实告知。
   *
   * 这条判据只有单测能钉住（真机上要在 6 秒内让对端点同意，手测不可复现）。
   */
  const undoRequest = async (deviceName: string) => {
    if (statusRef.current?.session?.phase !== "outbound_pending") {
      toast("对方已同意，申请无法撤回（可在会话里结束）", "info");
      return;
    }
    const ok = await rc.cancel();
    if (ok) toast(`已撤回对「${deviceName}」的申请`, "success");
    // 撤回失败必须说出来——否则用户以为申请已消失，对端却还挂着确认框
    else toast("撤回失败，申请可能仍在对方屏幕上，可在会话里结束", "error");
  };

  /** 在途闸：`rc.busy` 要等 invoke 落地才翻真，连点两下的第二发会在
   *  busy 生效前挤进 startChannel/request，变成两条并发发起（busy_local）。 */
  const launchingRef = useRef(false);

  const doRequest = async (id: string, c: RcCapability) => {
    if (launchingRef.current) return false;
    launchingRef.current = true;
    try {
      return await doRequestInner(id, c);
    } finally {
      launchingRef.current = false;
    }
  };

  const doRequestInner = async (id: string, c: RcCapability) => {
    setLastAttempt(id);
    // 名字在点击这一刻取：撤销回调要在 6 秒后才用，那时 targets 可能已经刷新
    const name = nameOf(id);
    if (!rc.status?.running && !(await rc.startChannel())) {
      toast("远程通道未能启动，请点顶部通道状态重试", "error");
      return false;
    }
    const ok = await rc.request(id, c);
    if (ok) {
      // 只记「这台设备用的档」与「上次的设备」——失败不该污染记忆。
      // 🔴 不再写全局 cap/rememberRequestCap：行内选档是单台的选择，
      //    写全局会让所有设备行一起变（2026-09-23 实测串台）。
      //    全局默认档的唯一写入口是设置页 setDefaultCap。
      setDeviceCaps((prev) => {
        const next = { ...prev, [id]: c };
        try {
          localStorage.setItem(LS_DEVICE_CAPS, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
      try {
        localStorage.setItem(LS_LAST, id);
        setLastPeer(id);
      } catch {
        /* ignore */
      }
      // 整行可点 ⇒ 误触成本是「对端屏幕上弹出一个他没预期的确认框」。
      // 撤回是真的（`rc_cancel_request`），所以不必给发起加一道确认框——
      // 确认框拦的是每一次**正确**的发起，撤销只在出错那一次付成本。
      undoToast(
        `已向「${name}」发起远程（${capabilityLabel(c)}）`,
        () => void undoRequest(name),
      );
    }
    return ok;
  };

  const forgetDevice = async (id: string) => {
    const done = await rc.forget(id);
    if (done && lastPeer === id) {
      setLastPeer(null);
      try {
        localStorage.removeItem(LS_LAST);
      } catch {
        /* ignore */
      }
    }
    return done;
  };

  /**
   * 设置页「默认发起方式」（v4 A 窗）：显式改默认档并立即持久化。
   * 与 doRequest 成功后的记忆是**同一个键**（rc_last_request_cap）——
   * 「上次用的档」和「用户选的默认档」必须是同一份，否则互相打架。
   */
  const setDefaultCap = (c: RcCapability) => {
    setCap(c);
    rememberRequestCap(c);
  };

  return { cap, capOf, setDefaultCap, lastPeer, lastAttempt, doRequest, forgetDevice };
}
