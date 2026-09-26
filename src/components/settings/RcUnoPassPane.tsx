/**
 * RcUnoPassPane — 无人值守固定密码管理面（方案 C，被控端）。
 *
 * 从 RcUnoDialog.tsx 拆出（组件 ≤300 行红线）。设置 / 更换固定密码，
 * 或查看开启状态 + 一键关闭。
 *
 * 🔴 与方案 B 的刻意差别：没有「接入后开免确认」的勾——「知道密码」与
 * 「这台设备可信」必须分离（unop.rs 模块注释），免确认请在设备列表里逐台开。
 */
import { useState } from "react";
import { UNO_PASS_MAX_CHARS, UNO_PASS_MIN_CHARS, unoPassCharsOk } from "@/lib/rcUno";
import { useRcStore } from "@/stores/rcStore";
import type { UseRc } from "@/hooks/useRc";
import type { ToastFn } from "@/components/Toast";
import styles from "../rc/RemoteComputer.module.css";

export function PassPane({ rc, toast }: { rc: UseRc; toast: ToastFn }) {
  const cur = rc.status?.uno_pass ?? null;
  const selfId = rc.identity?.node_id;
  const [pass, setPass] = useState("");
  const [cap, setCap] = useState<"control" | "view">("control");
  const [wan, setWan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const enable = async () => {
    const n = [...pass.trim()].length;
    if (n < UNO_PASS_MIN_CHARS) {
      setErr(`密码至少 ${UNO_PASS_MIN_CHARS} 个字符`);
      return;
    }
    if (n > UNO_PASS_MAX_CHARS) {
      setErr(`密码最多 ${UNO_PASS_MAX_CHARS} 个字符`);
      return;
    }
    setBusy(true);
    setErr("");
    const ok = await rc.unoPassEnable({ password: pass.trim(), capability: cap, allowWan: wan });
    setBusy(false);
    if (ok) {
      toast("无人值守固定密码已开启", "success");
      setPass("");
    } else {
      setErr(useRcStore.getState().error ?? "开启失败");
    }
  };

  const disable = async () => {
    setBusy(true);
    const ok = await rc.unoPassDisable();
    setBusy(false);
    if (ok) toast("已关闭无人值守固定密码", "info");
    else setErr(useRcStore.getState().error ?? "关闭失败");
  };

  const toggleWan = async (v: boolean) => {
    setBusy(true);
    const ok = await rc.unoPassSetWan(v);
    setBusy(false);
    if (!ok) setErr(useRcStore.getState().error ?? "切换失败");
  };

  if (cur) {
    const since = new Date(cur.since_ms).toLocaleTimeString();
    return (
      <>
        <div className={styles.foot}>
          <b>无人值守模式中</b>（自 {since}）：知道密码的设备可以直接远程本机，
          无需任何人在场确认。接入全程有横幅、有记录，防爆破有限速。
        </div>
        <div className={styles.foot}>
          接入授予：<b>{cur.cap === "control" ? "可控（能操作键鼠）" : "只看画面"}</b>
        </div>
        <label className={styles.unoRow}>
          <input type="checkbox" disabled={busy} checked={cur.wan} onChange={(e) => void toggleWan(e.target.checked)} />
          <span>允许跨网接入{cur.wan ? "（已打开——确保密码足够强）" : "（默认仅限局域网）"}</span>
        </label>
        {selfId && (
          <div className={styles.foot}>
            跨网时把<b>设备号</b>发给对方（同局域网不用，附近列表里能认出本机）：
            <div className={`${styles.pairPane} ${styles.unoMonoBlock} ${styles.unoMonoBlockSpaced}`}>
              {selfId}
            </div>
          </div>
        )}
        <input
          type="password"
          className={`${styles.unoInput} ${styles.unoInputSpaced}`}
          placeholder={`换密码：输入新密码（至少 ${UNO_PASS_MIN_CHARS} 个字符）`}
          value={pass}
          onChange={(e) => {
            setPass(e.target.value);
            setErr("");
          }}
        />
        {err && <div className={styles.noteBad}>{err}</div>}
        <div className={styles.unoActs}>
          {selfId && (
            <button
              type="button"
              className={styles.miniBtn}
              onClick={() => {
                void navigator.clipboard.writeText(selfId).then(
                  () => toast("设备号已复制", "success"),
                  () => toast("复制失败，请手动选择复制", "error"),
                );
              }}
            >
              复制设备号
            </button>
          )}
          <button
            type="button"
            className={styles.miniBtn}
            disabled={busy || !unoPassCharsOk(pass)}
            onClick={() => void enable()}
          >
            修改密码
          </button>
          <button type="button" className={styles.miniBtnPri} disabled={busy} onClick={() => void disable()}>
            关闭无人值守
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className={styles.foot}>
        给长期挂机的机器（自家服务器 / 出租机）设一个<b>固定密码</b>：知道密码的设备
        随时可连。哈希落盘、明文不存；接入有<b>限速与锁定</b>（连续错 5 次锁 10 分钟）；
        屏幕常驻「无人值守模式中」横幅，随时一键关闭。
      </div>
      <input
        type="password"
        className={`${styles.unoInput} ${styles.unoInputSpaced}`}
        placeholder={`固定密码（至少 ${UNO_PASS_MIN_CHARS} 个字符）`}
        value={pass}
        onChange={(e) => {
          setPass(e.target.value);
          setErr("");
        }}
      />
      <div className={styles.foot}>接入后对方可以：</div>
      <label className={styles.unoRow}>
        <input type="radio" checked={cap === "control"} onChange={() => setCap("control")} />
        <span>可控（能操作键鼠）</span>
      </label>
      <label className={styles.unoRow}>
        <input type="radio" checked={cap === "view"} onChange={() => setCap("view")} />
        <span>只看画面</span>
      </label>
      <label className={styles.unoRow}>
        <input type="checkbox" checked={wan} onChange={(e) => setWan(e.target.checked)} />
        <span>允许跨网接入（默认仅限同一局域网）</span>
      </label>
      {rc.status && !rc.status.enabled && (
        <div className={styles.noteWarn}>
          本机还没打开「允许被远程协助」——密码设了也连不进来，请先打开。
        </div>
      )}
      {err && <div className={styles.noteBad}>{err}</div>}
      <div className={styles.unoActs}>
        <button type="button" className={styles.miniBtnPri} disabled={busy || !unoPassCharsOk(pass)} onClick={() => void enable()}>
          开启固定密码
        </button>
      </div>
    </>
  );
}
