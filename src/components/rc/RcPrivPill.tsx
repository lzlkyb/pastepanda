/**
 * RcPrivPill — 丙-②：本机**正被远程**时的桌面常驻角标。
 *
 * 补的是审计 H1 的真实缺口：告知本来有（被控横幅），但它住在主窗里——主窗整场
 * 没打开、或被全屏应用盖着时，桌面上没有任何「有人正在看你屏幕」的痕迹。这块角标
 * 与主窗显隐无关（独立置顶窗口 `rc-ask` 的 `capsule` 形态，几何在 Rust 侧
 * `ask_pop.rs` 的 `CAP_W` / `EDGE_GAP`），会话期间一直在，点「结束」就地终止。
 *
 * 待拍板③（免确认设备要不要也告知）= **要**：判据是「会话相位是 InboundActive」，
 * 与当初走没走同意那条路无关——免确认只免「同意」，不免「告知」。
 *
 * 🔴 刻意**不做**的两件事：
 * - **无限闪烁动画**：这是一块常驻置顶窗，`@keyframes` 会让它整场会话不停重复合成
 *   （AGENTS.md §8：没实测就不写常驻动画）。红点常亮已经足够表意。
 * - **托盘图标变红**：待拍板⑥ 选「先不做」，六家无先例，且目前零接线、无法验证。
 *
 * 失败反馈只能做在角标里（同 `RcAskPop`：独立 webview 拿不到主窗的 `app-toast`，
 * AGENTS.md §15.1 触发与反馈必须同一个可见性域）。窗口只有 264×28，所以失败时是
 * **替换**那行文字，不是往下加一行。
 */
import { useCallback, useEffect, useState } from "react";
import { rcEndSession } from "@/lib/api/rcCommands";
import type { RcAskHost } from "@/lib/api/rc";
import { rcPrivElapsedText, rcPrivGrantText, rcPrivIsHot, rcPrivWhoText } from "@/lib/rcPrivPill";
import styles from "./RcPrivPill.module.css";

export function RcPrivPill({ host }: { host: RcAskHost }) {
  const [now, setNow] = useState(() => Date.now());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 计时器只在角标亮着时存在（形态切回确认卡 = 本组件卸载 = 定时器跟着没）
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const end = useCallback(() => {
    setBusy(true);
    setErr(null);
    void rcEndSession()
      .then(() => {
        /* 后端 emit rc-session-changed → Rust 换档收窗，这里不自己藏 */
      })
      .catch((e) => setErr(`没能结束：${String(e)}`))
      .finally(() => setBusy(false));
  }, []);

  const hot = rcPrivIsHot(host.capability);
  return (
    <div
      className={`${styles.pill} ${hot ? styles.hot : ""}`}
      role="status"
      title={`对方正在看这台电脑 · 能力：${rcPrivGrantText(host.capability)}`}
    >
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.txt}>{err ?? rcPrivWhoText(host.display_name)}</span>
      {!err && (
        <>
          <span className={styles.grant}>{rcPrivGrantText(host.capability)}</span>
          <span className={styles.time}>{rcPrivElapsedText(host.started_ms, now)}</span>
        </>
      )}
      <button
        type="button"
        className={styles.stop}
        disabled={busy}
        onClick={end}
        title="立刻断开这次远程"
      >
        {err ? "重试" : "结束"}
      </button>
    </div>
  );
}
