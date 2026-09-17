/**
 * StackHud —— 栈浮标的展示层（纯展示，无交互）。
 *
 * ## 它解决什么
 *
 * 栈是无窗口热键操作：用户按下 `Ctrl+Alt+P` 那一刻，焦点和视线都在**外部应用**里。
 * 主窗口里的 `StackBanner` 与 `app-toast` 他一个都看不到 —— 这个 240×65 的小窗
 * 是栈唯一的反馈出口。
 *
 * ## 为什么不做成可点按钮
 *
 * 它是 `focused(false)` + **点击穿透**（Rust 侧 `set_ignore_cursor_events(true)`）的
 * 纯展示窗。做成可点的前提是它能接收鼠标事件，那就会挡住用户对**目标应用**的点击 ——
 * 而这比"能点两下"重要得多。所有操作走热键。
 *
 * ## 尺寸是两份账
 *
 * Rust 侧 `stack_hud.rs` 的 `HUD_W / HUD_H` 定**窗口**大小，`StackHud.module.css`
 * 的 `.root` 定**容器**大小（`inset:0` 铺满，不写死宽高）。高度账：
 * `padding 8×2 + 主行 15 + gap 2 + 预览行 15 + gap 2 + 副行 15 = 65`。
 *
 * 描边刻意用 **inset 阴影**而不是 `border` —— `border: 1.5px` 在
 * `box-sizing: border-box` 下会吃掉 3px 布局空间，两行内容就放不下了。
 * 细节与实测见 `StackHud.module.css`。
 *
 * ## 方向尾
 *
 * `anchorKind === "control"` 时画底部小三角，建立「浮标 ↔ 聚焦输入框」的视觉指称。
 * 窗口 / 光标锚不画 —— 那时尾巴指向的是虚空。
 *
 * ## 跟随滑入（settle）
 *
 * Rust 轮询把窗口 `set_position` 到新落位是**瞬时**的，系统没有窗口级动画。
 * 滑入感只能由内容层伪造：窗口已到新位，内容先 `translate(旧−新)` 再动画回 0。
 * 位移矢量来自 `stack-hud-repositioned`（CSS 像素，Rust 侧已按 scale 换算并钳幅）。
 * 只 remount 内层三行（极轻），不 remount `.root` —— 后者会重播入场并丢掉 state 引用时机。
 */
import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { StackHudState } from "@/lib/stack/types";
import styles from "./StackHud.module.css";

/** 空闲多久淡到 55%。只影响观感、不影响正确性，可后调。 */
const IDLE_MS = 8000;

/** 跟随位移事件载荷（Rust `EVENT_REPOSITION`） */
type RepositionPayload = { dx: number; dy: number };

export function StackHud() {
  const [state, setState] = useState<StackHudState | null>(null);
  const [idle, setIdle] = useState(false);
  /**
   * 每次「窗口刚显示」递增一次，作为 `.root` 的 key —— React 重建元素，
   * CSS 的入场动画（`hudIn`）随之重播。
   *
   * 为什么用 key 而不是切换 class：动画重播要求元素**重新挂载**，
   * 在 React 里切 class 不保证动画重置（同一个 DOM 节点不会重跑 keyframes）。
   */
  const [shownAt, setShownAt] = useState(0);
  /** 调整模式：浮标恢复鼠标交互，可拖拽改位置（入口=托盘弹层，退出=双击） */
  const [adjusting, setAdjusting] = useState(false);
  /** 跟随滑入：tick 变化时 remount 内层以重播 settle；vec 为起始偏移（CSS px） */
  const [settleTick, setSettleTick] = useState(0);
  const [settleVec, setSettleVec] = useState<RepositionPayload>({ dx: 0, dy: 0 });
  const idleTimer = useRef<number | null>(null);

  useEffect(() => {
    const arm = () => {
      if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
      setIdle(false);
      idleTimer.current = window.setTimeout(() => setIdle(true), IDLE_MS);
    };

    // ❗ listen 的 Promise 被拒（典型：capability 没覆盖本窗口 ⇒ core:event:default
    // 缺失）时绝不能静默吞掉 —— 那会让 HUD 冻结在首帧而所有排查手段都查不到原因。
    const guard = <T,>(p: Promise<T>, tag: string): Promise<T> =>
      p.catch((e): T => {
        console.error(`[StackHud] ${tag} 监听注册失败:`, e);
        throw e;
      });

    const offUpdate = guard(
      listen<StackHudState>("stack-hud-update", (e) => {
        setState(e.payload);
        arm();
      }),
      "stack-hud-update"
    );
    // 窗口刚显示：重置空闲计时 + 重播入场动画（见 `shownAt`）。
    // 首次创建时这一事件通常赶不上 webview 就绪会丢掉，此时靠挂载那次动画顶上。
    const offShown = guard(
      listen("stack-hud-shown", () => {
        setShownAt((v) => v + 1);
        arm();
      }),
      "stack-hud-shown"
    );
    // 调整模式切换：Rust 侧已切好鼠标穿透，前端只负责拖拽 UI 与退出
    const offAdjust = guard(
      listen<boolean>("stack-hud-adjust", (e) => {
        setAdjusting(e.payload);
        if (e.payload) arm();
      }),
      "stack-hud-adjust"
    );
    // 窗口被轮询/推送挪到新位置：内容层做短滑入（见文件头「跟随滑入」）
    const offRepos = guard(
      listen<RepositionPayload>("stack-hud-repositioned", (e) => {
        const { dx, dy } = e.payload;
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
        setSettleVec({ dx, dy });
        setSettleTick((t) => t + 1);
        arm();
      }),
      "stack-hud-repositioned"
    );

    // 首帧：窗口**首次**创建时后端的 emit 可能早于本 webview 的 JS 就绪，
    // 那次事件就丢了（表现为浮标首帧空白）。所以主动拉一次缓存的快照。
    invoke<StackHudState | null>("stack_hud_state")
      .then((s) => {
        if (s) setState(s);
      })
      .catch(() => {
        /* 拉不到就等下一次广播 */
      });

    arm();
    return () => {
      void offUpdate.then((f) => f());
      void offShown.then((f) => f());
      void offAdjust.then((f) => f());
      void offRepos.then((f) => f());
      if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    };
  }, []);

  if (!state) return null;

  const { phase, count, hint, hotkey, target, next, progress, anchorKind } = state;
  let main: ReactNode;
  let sub: string;

  if (phase === "done") {
    main = (
      <>
        <span className={styles.markOk}>✓</span>全部粘贴完毕
      </>
    );
    sub = hint ?? "已退出栈模式";
  } else if (phase === "error") {
    // 主行刻意**泛化**，不写具体原因。
    //
    // 失败源是 `paste.ts` 四处 API 的失败分支，原因至少有五种：未找到目标窗口 /
    // 无法切换到目标窗口 / 目标窗口已关闭 / 剪贴板被占用（重试 10 次仍被拒）/
    // 上一个粘贴仍在进行中。原先这里写死「未找到目标窗口」，把「剪贴板被别的程序
    // 占着」也说成找不到窗口，**把人往错方向引**（该去关占用剪贴板的程序）。
    // 240px 也塞不下五种原因；用户此刻真正需要确认的是「数据还在不在」，
    // 那件事由副行的 `hint` 承担（见 `hudBridge.ts::hudPastedFailed`）。
    main = (
      <>
        <span className={styles.markErr}>✕</span>粘贴失败
      </>
    );
    sub = hint ?? "这条已保留在栈里";
  } else if (phase === "success") {
    main = (
      <>
        <span className={styles.markOk}>✓</span>已粘贴
        <span className={styles.sep}>·</span>剩 {count} 条
      </>
    );
    sub = hint ?? `${hotkey} 继续`;
  } else {
    main = (
      <>
        <span className={styles.dot} />
        <span className={styles.num}>栈 {count}</span>
        <span className={styles.sep}>·</span>
        {target ? (
          <span className={styles.target}>→ {target}</span>
        ) : (
          <span className={styles.warn}>未选择窗口</span>
        )}
      </>
    );
    sub = hint ?? (target ? `${hotkey} 粘贴下一条` : "切到目标窗口后按热键");
  }

  // 进度徽章：done 不渲染；collecting/success/error 在 total>0 时显示
  const progressNode =
    progress && progress.total > 0 && phase !== "done" ? (
      <span className={styles.prog}>
        {progress.done}/{progress.total}
      </span>
    ) : null;

  /**
   * 状态类：**显式映射**而不是 `styles[phase]`。
   *
   * 动态索引有两个静默失效面：
   * 1. CSS 类名一旦漂移（改名/删类），`styles.success` 得到 `undefined`，
   *    被下面的 `.filter(Boolean)` 悄悄吃掉 —— 状态色全丢，而 tsc 与 vitest 都查不出；
   * 2. `phase` 若意外是个 `"root"` / `"main"` / `"idle"` 之类的值，动态索引会**命中
   *    无关的类**造成错乱；显式映射下它只会落到空串。
   */
  const phaseCls =
    phase === "success"
      ? styles.success
      : phase === "error"
        ? styles.error
        : phase === "done"
          ? styles.done
          : ""; // collecting 沿用默认橙色描边，没有专属类

  const cls = [
    styles.root,
    phaseCls,
    adjusting ? styles.adjusting : "",
    idle && !adjusting ? styles.idle : "",
    anchorKind === "control" ? styles.tail : "",
  ]
    .filter(Boolean)
    .join(" ");

  // 调整模式下副行固定为操作指引（双击由 Rust 侧保存偏移并恢复穿透）
  const subFinal = adjusting ? "拖动调整位置 · 双击完成" : sub;

  // settle 只作用在内层：窗口已瞬时到位，内容从旧位滑入。调整中不播（正被拖着）。
  const settleActive = settleTick > 0 && !adjusting;
  const innerCls = settleActive ? `${styles.body} ${styles.settle}` : styles.body;
  const innerStyle: CSSProperties | undefined = settleActive
    ? ({
        ["--settle-x" as string]: `${settleVec.dx}px`,
        ["--settle-y" as string]: `${settleVec.dy}px`,
      } as CSSProperties)
    : undefined;

  return (
    <div
      key={shownAt}
      className={cls}
      role="status"
      aria-live="polite"
      onMouseDown={
        adjusting
          ? (e) => {
              // 阻止默认行为（文本选择/图片拖拽），交给系统级窗口移动
              e.preventDefault();
              void getCurrentWebviewWindow().startDragging();
            }
          : undefined
      }
      onDoubleClick={
        adjusting
          ? () => {
              invoke("stack_hud_adjust", { enter: false }).catch(() => {
                /* 退出失败保持调整态，可从托盘弹层再退出 */
              });
            }
          : undefined
      }
    >
      {/*
        内层 key 含 settleTick：位移时只重建三行（极轻），重播 settleIn；
        不用 root 的 key —— 那会连入场动画和状态拉取时机一起搅乱。
      */}
      <div key={`body-${settleTick}`} className={innerCls} style={innerStyle}>
        <div className={styles.main}>
          {main}
          {progressNode}
        </div>
        {/*
          预览行：下一条要粘贴的内容（`hudBridge.ts` 生成的 `next`）。
          栈空（done / 刚进栈模式）时为 null 不渲染 —— 窗口高度是固定的 65px，
          done 短暂停留 1.5s 的留白可接受，不值得为动态高度再开一条尺寸同步账。
        */}
        {next ? <div className={styles.preview}>{next}</div> : null}
        <div className={styles.sub}>{subFinal}</div>
      </div>
    </div>
  );
}