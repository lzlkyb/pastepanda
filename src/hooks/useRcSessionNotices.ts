/**
 * useRcSessionNotices — 会话内「一次性通知」收口（2026-09-17 从 `RcSessionView` 抽出）。
 *
 * 收三类**说一次就够**的消息，都与状态展示（HUD / 顶栏 / 底栏）无关，
 * 所以不该混在会话壳里：
 *
 * 1. **对端注入失败**（UIPI 等把键鼠拦了）——后端每个会话只保留最近一条。
 * 2. **路径自动切换**（iroh 每 60s 尝试把中继升级成直连）——不给提示的话，
 *    用户只会看到延迟突然从 90ms 掉到 12ms 却不知道为什么。
 * 3. **推送剪贴板被拒/失败**（D11，2026-09-22）——被控端只看会话、内容超 48KB、
 *    或写不进它的剪贴板时，过去是**静默**的：发起端界面照样报「已推送」，
 *    用户到对端粘贴才发现是旧内容（规则 15.3）。现在后端回帧，这里 toast 出真因。
 *
 * 抽出来的直接原因：`RcSessionView` 是 300 行红线的文件，这两个 effect
 * 再留在里面就会把它推过线。
 */
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { pathKindLabel } from "@/lib/rcSessionStats";

export function useRcSessionNotices({
  pathNotice,
  onPathConsumed,
  notify,
}: {
  /** 待提示的换路信息；null = 没有。 */
  pathNotice: { from: string; to: string } | null;
  /** 提示完成后调用（清掉 store 里那条，避免下次挂载重复弹）。 */
  onPathConsumed: () => void;
  notify: (msg: string, kind?: "error") => void;
}) {
  // 对端注入失败。同一个 msg 只报一次：后端可能在重试同一件事，
  // 不去重的话用户会被同一条 toast 刷屏。
  useEffect(() => {
    let off: (() => void) | undefined;
    let last = "";
    void listen<string>("rc-inject-error", (e) => {
      const msg = e.payload;
      if (!msg || msg === last) return;
      last = msg;
      notify(`对方未能注入输入：${msg}`, "error");
    })
      .then((f) => {
        off = f;
      })
      .catch(() => {
        /* 非 Tauri 环境：忽略。listen 的拒绝必须留痕，不能让它变成
           unhandled rejection 后静默丢掉整条通知链路 */
      });
    return () => off?.();
  }, [notify]);

  // 推送剪贴板被拒/失败（D11）。去重纪律同 inject-error：后端可能对同一份
  // 内容反复重试（自动同步每 2s 一次），不去重会被同一条 toast 刷屏。
  useEffect(() => {
    let off: (() => void) | undefined;
    let last = "";
    void listen<string>("rc-clip-push-error", (e) => {
      const msg = e.payload;
      if (!msg || msg === last) return;
      last = msg;
      notify(`推送剪贴板失败：${msg}`, "error");
    })
      .then((f) => {
        off = f;
      })
      .catch(() => {
        /* 非 Tauri 环境：忽略（理由同 inject-error） */
      });
    return () => off?.();
  }, [notify]);

  // 路径切换。用 `pathKindLabel` 兜底原始串：档位串是稳定值，
  // 后端将来多出一档（如自定义 transport）时也该说得出话。
  useEffect(() => {
    if (!pathNotice) return;
    notify(
      `连接路径已切换：${pathKindLabel(pathNotice.from) || pathNotice.from} → ${
        pathKindLabel(pathNotice.to) || pathNotice.to
      }`,
    );
    onPathConsumed();
  }, [pathNotice, onPathConsumed, notify]);
}
