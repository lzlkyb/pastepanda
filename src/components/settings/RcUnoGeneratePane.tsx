/**
 * RcUnoGeneratePane — 无人值守「被控端出码」那一页（方案 B）。
 *
 * 从 RcUnoDialog.tsx 拆出（组件 ≤300 行红线）。码只在生成那一刻可见，
 * 关掉弹层就再也找不回来（刻意的——防落盘）。
 */
import { useEffect, useState } from "react";
import { useRcStore } from "@/stores/rcStore";
import type { UseRc } from "@/hooks/useRc";
import type { ToastFn } from "@/components/Toast";
import { RcCredTag } from "./RcCredTag";
import styles from "../rc/RemoteComputer.module.css";

const TTL_SHORT_SECS = 15 * 60;
const TTL_DAY_SECS = 24 * 60 * 60;

export function GeneratePane({ rc, toast, onClose }: { rc: UseRc; toast: ToastFn; onClose: () => void }) {
  const [ttl, setTtl] = useState<"short" | "day">("short");
  const [cap, setCap] = useState<"control" | "view">("control");
  const [alsoTrust, setAlsoTrust] = useState(false);
  const [created, setCreated] = useState<{ code: string; full: string; expires_at: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!created) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [created]);

  const generate = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await rc.unoGenerate({
        ttlSecs: ttl === "short" ? TTL_SHORT_SECS : TTL_DAY_SECS,
        unlimited: ttl === "day",
        capability: cap,
        alsoTrust,
      });
      setCreated(r);
      setNow(Date.now());
    } catch (e) {
      setErr(typeof e === "string" ? e : e instanceof Error ? e.message : "生成失败");
    } finally {
      setBusy(false);
    }
  };

  const revokeAll = async () => {
    // run() 失败不抛异常而是返回 false——不看返回值就报「已撤销」是安全
    // 语义的假成功：码实际还在生效，对方仍可凭码连入（2026-09-19 审查 P2）。
    const ok = await rc.unoRevoke();
    if (ok) {
      toast("已撤销全部接入码", "info");
      onClose();
    } else {
      setErr(useRcStore.getState().error ?? "撤销失败，请重试");
    }
  };

  if (!created) {
    // 首屏减负（2026-09-26 对齐稿）：默认值升格成按钮正上方的一句「承诺」——
    // 它就是点大按钮将要做的事，随高级区改动实时更新；五个平铺决策收进
    // <details>（不砍功能，只换可见性层级，装机/代看/免确认各归其位）。
    const promise = [
      ttl === "short" ? "15 分钟 · 用 1 次" : "24 小时 · 不限次",
      cap === "control" ? "可控" : "只看画面",
      ...(alsoTrust ? ["开免确认"] : []),
    ].join(" · ");
    return (
      <>
        <RcCredTag tone="uno" label="无人值守码" note="对面没人也能连 · 用完记得撤销" />
        <div className={styles.foot}>
          对方不在电脑前也能连：码<b>会过期、可撤销</b>，接入全程有横幅、有记录。
        </div>
        {rc.status && !rc.status.enabled && (
          <div className={styles.noteWarn}>
            本机还没打开「允许被远程协助」——先生成码也行，但对方连不进来。
          </div>
        )}
        {err && <div className={styles.noteBad}>{err}</div>}
        <div className={styles.unoDefaultLine}>
          将生成：<b>{promise}</b> 的接入码。
        </div>
        <button
          type="button"
          className={`${styles.miniBtnPri} ${styles.unoBtnBig}`}
          disabled={busy}
          onClick={() => void generate()}
        >
          {busy ? "生成中…" : "生成接入码"}
        </button>
        <details className={styles.unoAdv}>
          <summary>高级：改时效 / 只看画面 / 免确认</summary>
          <label className={styles.unoRow}>
            <input type="radio" checked={ttl === "short"} onChange={() => setTtl("short")} />
            <span>15 分钟 · 限 1 次（帮人修电脑）</span>
          </label>
          <label className={styles.unoRow}>
            <input type="radio" checked={ttl === "day"} onChange={() => setTtl("day")} />
            <span>24 小时 · 不限次（装机 / 挂机，可随时撤销）</span>
          </label>
          <label className={styles.unoRow}>
            <input type="radio" checked={cap === "control"} onChange={() => setCap("control")} />
            <span>可控（能操作键鼠）</span>
          </label>
          <label className={styles.unoRow}>
            <input type="radio" checked={cap === "view"} onChange={() => setCap("view")} />
            <span>只看画面（对方不能动键鼠）</span>
          </label>
          <label className={styles.unoRow}>
            <input type="checkbox" checked={alsoTrust} onChange={(e) => setAlsoTrust(e.target.checked)} />
            <span>接入后给这台设备开免确认（下次不用再给码；可随时关）</span>
          </label>
        </details>
        <div className={styles.unoActs}>
          <button type="button" className={styles.miniBtn} onClick={onClose}>
            返回
          </button>
        </div>
      </>
    );
  }

  const leftMs = Math.max(0, created.expires_at - now);
  const leftText =
    leftMs >= 3600_000
      ? `${Math.floor(leftMs / 3600_000)} 小时 ${Math.floor((leftMs % 3600_000) / 60_000)} 分`
      : `${Math.max(1, Math.floor(leftMs / 60_000))} 分钟`;
  return (
    <>
      <RcCredTag tone="uno" label="无人值守码" note="用完记得点「撤销并关闭」" />
      <div className={styles.foot}>把这个码念给对方（或原样发给对方）：</div>
      <div className={styles.unoCodeBox} aria-label="无人值守码">
        {created.code}
      </div>
      <div className={styles.foot}>
        有效期还剩 <b>{leftText}</b>；{ttl === "short" ? "限用 1 次。" : "24 小时内不限次。"}
        对方跨网连接时需要<b>完整接入串</b>（含设备号）：
      </div>
      <div className={`${styles.pairPane} ${styles.unoMonoBlock}`}>
        {created.full}
      </div>
      <div className={styles.unoActs}>
        <button
          type="button"
          className={styles.miniBtn}
          onClick={() => {
            void navigator.clipboard.writeText(created.full).then(
              () => toast("完整接入串已复制，发给对方", "success"),
              () => toast("复制失败，请手动选择复制", "error"),
            );
          }}
        >
          复制完整接入串
        </button>
        <button type="button" className={styles.miniBtnPri} onClick={() => void revokeAll()}>
          撤销并关闭
        </button>
      </div>
    </>
  );
}
