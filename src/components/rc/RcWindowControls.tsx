/**
 * RcWindowControls — rc 工作台的自绘窗口按钮组（最小化 / 最大化·还原 / 关闭）。
 *
 * 工作台窗口改 `decorations(false)` 后系统按钮没了，这三个补上（批7，2026-09-22）。
 * 尺寸与配色照 A 方案稿 `.window-action`：46px 宽 × 满高、`cursor: default`
 * （Windows 原生窗口按钮不是手形）、关闭键 hover 红底白字。稿子的 hover 灰是
 * 写死的 `#e7ebf1`，这里换成与主题混色——工作台跟随主题，暗色下写死浅灰会发白。
 *
 * 🔴 **关闭走 `close()`，不是 `destroy()`**：`useRcWorkbenchClose` 拦的是
 *    `onCloseRequested`（有会话时先弹确认，选「结束会话并关闭」才 end + destroy）。
 *    这里直接 destroy 会绕过那道守卫，现象是「点了关闭，会话还在跑、窗口却没了」
 *    ——正是它要防的。权限见 `src-tauri/capabilities/rc-workbench.json`。
 *
 * 拖拽不归它管：宿主条挂了 `data-tauri-drag-region="deep"`，而「可点击元素不带该
 * 属性时自动阻断拖动」是 Tauri 注入脚本的规则，按钮天然豁免；容器上再补一个
 * `="false"`，免得按钮之间的缝隙被当成拖动区（稿子的按钮是紧挨的，本不该有缝）。
 */
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { logger } from "@/lib/logger";
import styles from "./RemoteComputerA2.module.css";

/** 图标照稿子的 `<symbol>` 同形（viewBox 24 / stroke currentColor）。 */
function Icon({ name }: { name: "min" | "max" | "restore" | "close" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      aria-hidden="true"
    >
      {name === "min" && <path d="M5 12h14" />}
      {name === "max" && <rect x="6" y="6" width="12" height="12" />}
      {/* 还原态：两个叠框（Windows 的 restore 图标） */}
      {name === "restore" && (
        <>
          <rect x="8.5" y="4.5" width="11" height="11" />
          <path d="M4.5 8.5v7a4 4 0 0 0 4 4h7" />
        </>
      )}
      {name === "close" && <path d="m7 7 10 10M17 7 7 17" />}
    </svg>
  );
}

function runWin(fn: () => Promise<unknown>, what: string) {
  try {
    void fn().catch((e) => logger.warn(`窗口${what}失败`, e));
  } catch (e) {
    // `getCurrentWindow()` 读的是 `window.__TAURI_INTERNALS__`，非 Tauri 环境
    // （浏览器里直开 rc.html 看版式）**会同步抛**——那一刻还没拿到 Promise，
    // 上面那个 `.catch` 接不住。不兜住的话，一次点击就能把整页推给 ErrorBoundary。
    logger.warn(`窗口${what}失败`, e);
  }
}

/**
 * 关闭键。单独导出是因为**会话态整条顶栏只补这一枚**：那一态窗口没有标题栏，
 * 画面铺满，用户在顶条上最需要的就是「能把它关掉」；最小化 / 最大化另有系统
 * 替代（任务栏、双击顶条、Win+方向键），不必再占顶条宽度。
 */
export function RcCloseButton() {
  return (
    <button
      type="button"
      className={`${styles.winBtn} ${styles.winBtnClose}`}
      aria-label="关闭"
      title="关闭"
      onClick={() => runWin(() => getCurrentWindow().close(), "关闭")}
    >
      <Icon name="close" />
    </button>
  );
}

export function RcWindowControls() {
  const [maximized, setMaximized] = useState(false);

  // 挂载时读一次 + 窗口尺寸变化时同步（最大化/还原、Aero Snap、手动拖边框都会触发）。
  // 照 `FullscreenEditor` 的 onResized 先例：StrictMode 下 effect 跑两遍，而 unlisten
  // 是 await 之后才赋值的，cleanup 先跑时它还是 undefined——所以用 disposed 兜住迟到的订阅。
  // 会话态只渲染 `RcCloseButton`（不走这个组件），故不必为它做条件化——hooks 也不能条件调用。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    /* 🔴 `getCurrentWindow()` 在非 Tauri 环境**同步抛**（它读 `window.__TAURI_INTERNALS__`
       的 metadata）。浏览器里直开 `rc.html` 看版式就会走到这里——2026-09-22 真机预览
       实测到：没兜住时整页被 ErrorBoundary 接管（"Cannot read properties of undefined
       (reading 'metadata')"）。所以这里必须 try/catch，点击路径另有 runWin 兜一次。 */
    try {
      const win = getCurrentWindow();
      const sync = () => {
        win
          .isMaximized()
          .then((v) => {
            if (!disposed) setMaximized(v);
          })
          .catch(() => {
            /* 读不到就保持当前图标，不编状态 */
          });
      };
      sync();
      win
        .onResized(sync)
        .then((fn) => {
          if (disposed) fn();
          else unlisten = fn;
        })
        .catch(() => {
          /* 非 Tauri 环境（vitest）：忽略 */
        });
    } catch {
      /* 没有窗口可控制，按钮保持默认图标即可 */
    }
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return (
    <div className={styles.winControls} data-tauri-drag-region="false" aria-label="窗口控制">
      <button
        type="button"
        className={styles.winBtn}
        aria-label="最小化"
        title="最小化"
        onClick={() => runWin(() => getCurrentWindow().minimize(), "最小化")}
      >
        <Icon name="min" />
      </button>
      <button
        type="button"
        className={styles.winBtn}
        aria-label={maximized ? "向下还原" : "最大化"}
        title={maximized ? "向下还原" : "最大化"}
        onClick={() =>
          runWin(() => getCurrentWindow().toggleMaximize(), maximized ? "还原" : "最大化")
        }
      >
        <Icon name={maximized ? "restore" : "max"} />
      </button>
      <RcCloseButton />
    </div>
  );
}
