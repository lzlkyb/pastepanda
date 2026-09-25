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

/**
 * 🔴 2026-09-23 复审：`rc-inject-error` 事件在**两侧机器语义不同**——
 * 发起端收到的是对端转发来的注入失败（「对方未能注入输入」，见下方 hook）；
 * 被控端收到的却是**本机自己**出问题的两条：① UIPI 拦了对方键鼠（inbound.rs
 * 本地 set）② 会话收口时释放按住键失败（P1-3）。原先只有 `RcSessionView`
 * （发起端视图）挂着监听，被控端这两个本地故障**没有任何接收者**——
 * 键卡在按下态的人恰恰看不到提示。本 hook 补上被控侧，主语写对。
 *
 * 模块级去重：同一窗口里若被双挂（横幅 + 会话视图），同串只弹一次。
 * 跨窗口各弹各的是本应用的既有形态（横幅本来就每窗一份）。
 *
 * `enabled` 是给主窗口（RcOverlay）准备的：同一个事件在发起端机器上也会
 * 到达（对端转发），若不分相位常驻监听，控制端用户会看到以「本机」为主语
 * 的提示——主语错了。调用方按 inbound_active 相位开监听即可。
 */
let lastLocalInject = "";

export function useRcLocalInjectNotice(
  notify: (msg: string, kind?: "error") => void,
  enabled = true,
) {
  useEffect(() => {
    if (!enabled) return;
    let off: (() => void) | undefined;
    // 🔴 再审计 B12（2026-09-25）：cleanup 可能先于 listen resolve 跑
    //（StrictMode 双挂载 / 快速重挂）——那时 off 还没赋值，`off?.()` 会把
    // 监听器永久漏掉（泄漏的监听器还持旧闭包继续弹 toast）。
    // 同款守卫见 useRcCursor / useRcWorkbenchClose。
    let disposed = false;
    void listen<string>("rc-inject-error", (e) => {
      const msg = e.payload;
      if (!msg || msg === lastLocalInject) return;
      lastLocalInject = msg;
      notify(`本机未能注入输入：${msg}`, "error");
    })
      .then((f) => {
        if (disposed) f();
        else off = f;
      })
      .catch(() => {
        /* 非 Tauri 环境：忽略（理由同发起端那条监听） */
      });
    return () => {
      disposed = true;
      off?.();
    };
  }, [notify, enabled]);
}

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
  // 🔴 再审计 B12：disposed 守卫（理由见上方 useRcLocalInjectNotice）。
  useEffect(() => {
    let off: (() => void) | undefined;
    let disposed = false;
    let last = "";
    void listen<string>("rc-inject-error", (e) => {
      const msg = e.payload;
      if (!msg || msg === last) return;
      last = msg;
      notify(`对方未能注入输入：${msg}`, "error");
    })
      .then((f) => {
        if (disposed) f();
        else off = f;
      })
      .catch(() => {
        /* 非 Tauri 环境：忽略。listen 的拒绝必须留痕，不能让它变成
           unhandled rejection 后静默丢掉整条通知链路 */
      });
    return () => {
      disposed = true;
      off?.();
    };
  }, [notify]);

  // 推送剪贴板被拒/失败（D11）。去重纪律同 inject-error：后端可能对同一份
  // 内容反复重试（自动同步每 2s 一次），不去重会被同一条 toast 刷屏。
  useEffect(() => {
    let off: (() => void) | undefined;
    let disposed = false;
    let last = "";
    void listen<string>("rc-clip-push-error", (e) => {
      const msg = e.payload;
      if (!msg || msg === last) return;
      last = msg;
      notify(`推送剪贴板失败：${msg}`, "error");
    })
      .then((f) => {
        if (disposed) f();
        else off = f;
      })
      .catch(() => {
        /* 非 Tauri 环境：忽略（理由同 inject-error） */
      });
    return () => {
      disposed = true;
      off?.();
    };
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
