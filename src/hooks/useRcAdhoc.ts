/**
 * useRcAdhoc — 把 `lib/rcAdhoc` 的判据接到 `rcStore`（一次性协助的「用后即忘」）。
 *
 * 判据全在 `lib/rcAdhoc`（纯函数，有单测）；本文件只做两件事：
 *  1. 按 `phase:peer` 的签名在**会话状态变化时**喂一次 `stepAdhoc`；
 *  2. 拿到该忘的 id 就调 `rc.forget`。
 *
 * # 🔴 为什么状态以「盘」为准，而不是攥一个 ref
 *
 * `armedAt` / `peers` 是**出码方与粘码方各自写入**的：出码在 `RcAdhocDialog`
 * （挂载期很短），结账在本 hook（挂载期很长）。两边各攥一份内存副本必然对不上
 * ——对话框写盘、hook 拿旧副本去 step，下一次落盘就把刚写进去的 peer 抹掉。
 * 所以这里**每轮都从盘上重读**，只有 `live`（「这个 peer 真的连上过」的进程内
 * 证据）留在 ref 里，因为它本来就不落盘。
 *
 * # 挂在哪几个地方
 *
 * 必须挂**常驻**的窗口，不能挂在对话框里——对话框在会话开始前就关了，
 * 那时才需要结账。所以：
 *  - `RcOverlay`（主窗口，任何模式下都渲染，即使它自己 `return null`）；
 *  - `RcWorkbench`（工作台独立窗口）。
 * 两个窗口看到的是**同一个后端会话**，谁先看到结束谁清；`rc_forget` 幂等，
 * 重复调无害。这也顺手覆盖了「关掉工作台窗口」的情况——主窗口那份接着清。
 */
import { useEffect, useRef } from "react";
import type { UseRc } from "@/hooks/useRc";
import { loadAdhoc, saveAdhoc, stepAdhoc } from "@/lib/rcAdhoc";

export function useRcAdhoc(rc: UseRc) {
  const session = rc.status?.session ?? null;
  const forget = rc.forget;
  /** 进程内的「真的连上过」证据（不落盘，见 `lib/rcAdhoc` 的说明）。 */
  const liveRef = useRef<string[]>([]);

  // 只在「阶段 / 对象」真的变了时才结算。用字符串签名而不是 session 对象：
  // `rc.status` 每轮轮询都是新对象，用对象当依赖等于每秒重算一次。
  const sig = session ? `${session.phase}:${session.peer}` : "idle";

  useEffect(() => {
    const before = loadAdhoc();
    const r = stepAdhoc({ ...before, live: liveRef.current }, session, Date.now());
    liveRef.current = r.state.live;
    // 只在落盘字段真的变了时才写。轮询频率下无脑写盘是白耗，也会把
    // 刚被对话框改过的值原样覆盖回去（值相同，覆盖无害，但没必要）。
    if (r.state.armedAt !== before.armedAt || r.state.peers.length !== before.peers.length) {
      saveAdhoc(r.state);
    }
    r.forget.forEach((id) => void forget(id));
    // session 以 sig 参与去重，故不列进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
}
