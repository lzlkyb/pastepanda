/**
 * useRcWorkbenchClose — 工作台窗口的系统关闭钮行为：「有会话时先问，没会话直接放行」。
 *
 * 从 RcWorkbench 抽出来（那个文件因主区多一个被控分支后涨到 317 行，超了 .tsx ≤ 300）。
 * 这段话和「主区该显示什么」是两件不相干的事，本来就不该挤在同一个文件里。
 *
 * 🔴 2026-09-18 修「点 X 关不掉」：
 * 1) `@tauri-apps/api` 的 `onCloseRequested` 在**没调 preventDefault** 时，收尾由它自己
 *    `await this.destroy()` 完成；而 `destroy()` 打的是 `plugin:window|destroy`，
 *    需要 `core:window:allow-destroy`。原先 capabilities 只给了 `allow-close`，
 *    于是**两条分支（有会话 / 没会话）都关不掉**，且 `void destroy()` 把拒绝静默吞掉，
 *    现象就是「点 X 毫无反应」。权限见 `src-tauri/capabilities/rc-workbench.json`。
 * 2) 订阅改成**只在挂载时做一次**（原实现依赖 `hasLiveSession` 重订阅）：
 *    · React StrictMode 下 effect 会跑两遍，而 `unlisten` 是 `await` 之后才赋值的
 *      ⇒ cleanup 跑时它还是 undefined，第一个监听器**永远摘不掉**。两个监听器同时在场时，
 *      第二个的 `confirmDialog` 会命中「已有待决请求 → 直接返回 false」，
 *      于是**绕过用户选择**立刻 destroy（窗口关掉了，会话却没结束）。
 *    · 依赖变化还会留出一段「已退订、新订阅还没回来」的空窗，此时点 X 会直接放行。
 *    现在改为订阅一次 + ref 读最新值：既没有重复监听，也没有空窗。
 */
import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirmDialog } from "@/lib/confirm";
import { logger } from "@/lib/logger";

export function useRcWorkbenchClose(hasLiveSession: boolean, endSession: () => Promise<unknown>) {
  // 只订阅一次，所以「有没有会话」和「怎么结束会话」都从 ref 取最新值。
  // 直接写 ref.current 而不是在 effect 里同步：渲染期间赋值即可，订阅回调是异步触发的。
  const liveRef = useRef(hasLiveSession);
  liveRef.current = hasLiveSession;
  const endRef = useRef(endSession);
  endRef.current = endSession;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        const un = await getCurrentWindow().onCloseRequested(async (event) => {
          if (!liveRef.current) return; // 没会话，直接放行（框架的 wrapper 会自己 destroy）
          event.preventDefault();
          let ok = false;
          try {
            ok = await confirmDialog({
              title: "关闭远程电脑",
              message:
                "当前仍有进行中的远程会话。\n确认 = 结束会话并关闭；取消 = 保持会话，仅关闭此窗口。",
              confirmText: "结束会话并关闭",
              cancelText: "保持会话",
              variant: "danger",
            });
          } catch (e) {
            // 弹窗本身把 promise 丢了（宿主没挂 / 抛错）时不能就这么僵住：按「仅关窗」走。
            logger.warn("关闭确认弹窗失败，按「仅关窗」处理", e);
          }
          if (ok) {
            try {
              await endRef.current();
            } catch (e) {
              // 结束会话失败不该把窗口一起锁死——用户按的是「关闭」。
              logger.warn("结束远程会话失败，仍继续关闭窗口", e);
            }
          }
          try {
            await getCurrentWindow().destroy();
          } catch (e) {
            logger.error("关闭远程电脑窗口失败", e);
          }
        });
        // 迟到的订阅要立刻退订，否则监听器会一直活着。
        // 真实 dev 应用开着 StrictMode（rc-main.tsx），effect 会跑两遍，而 `unlisten`
        // 是 await 之后才赋值的 —— cleanup 先跑时它还是 undefined，那个订阅就摘不掉了。
        // （注意：vitest 里实测**不**双跑 effect，所以单测用「unlisten 迟到」复现同一竞态，
        //   见 rcWorkbenchClose.test.tsx 第一条。）
        if (disposed) un();
        else unlisten = un;
      } catch {
        /* 非 Tauri 环境（vitest）：忽略 */
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
