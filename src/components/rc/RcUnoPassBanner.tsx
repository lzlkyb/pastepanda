/**
 * RcUnoPassBanner — 「无人值守固定密码已开启」的**常驻**横幅（Q2 方案 C）。
 *
 * B2（2026-09-23）从 `RcOverlay` 拆出（300 行红线，拆分先行）；补失败 toast。
 *
 * 存在意义：会话中被控横幅已在说「谁在控」，这里不叠加；除此之外的所有时刻
 * 都要挂着——「这台机器正对着知道密码的人开着门」不能只有设置页知道。
 * 一键全局关闭就在这条上，这是泄露密码后的止损按钮。
 */
import { useToast } from "@/components/Toast";
import { runRcAction } from "@/lib/rcFeedback";
import type { RcUnoPassInfo } from "@/lib/api/rc";
import styles from "./RemoteComputer.module.css";

export function RcUnoPassBanner({
  unoPass,
  busy,
  onDisable,
}: {
  unoPass: RcUnoPassInfo;
  busy: boolean;
  onDisable: () => Promise<boolean>;
}) {
  const { toast } = useToast();
  return (
    <div className={styles.ctrlBanner} role="status">
      <span className={styles.who}>
        <span className={styles.live} />
        无人值守模式中 · 固定密码接入已开启
      </span>
      <span className={styles.pillOn}>{unoPass.cap === "control" ? "可控" : "只看"}</span>
      <span className={styles.sp} />
      <span className={styles.meta}>
        {unoPass.wan ? "跨网已允许（有限速防爆破）" : "仅限同一局域网"}
      </span>
      <button
        type="button"
        className={styles.dangerBtn}
        disabled={busy}
        onClick={() => {
          void runRcAction(
            onDisable,
            { ok: "已关闭无人值守固定密码", fail: "关闭失败" },
            toast,
          );
        }}
      >
        一键关闭
      </button>
    </div>
  );
}
