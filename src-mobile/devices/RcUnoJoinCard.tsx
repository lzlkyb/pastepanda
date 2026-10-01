/**
 * RcUnoJoinCard — 手机端无人值守接入（Q2 方案 B/C 的发起端那一半）。
 *
 * 场景：电脑前没人（远程 回家/机房），拿电脑提前出示的凭证直接连。
 * 与桌面 `RcUnoJoinPane` 同一套判据（parseUnoInput / unoCodeShapeOk /
 * unoPassCharsOk——lib/rcUno 单一来源），但入口按手机改写：
 * - **扫一扫**是第一入口：电脑端无人值守弹层贴着完整接入串，扫了就有 node_id；
 * - 裸码（电话里念的 8 位）不带机器定位，只能从**已配对设备**里认——
 *   桌面「附近设备」轮询在手机上收成同一列表（配对过 ≈ 同网用过），
 *   没有候选就诚实指路「让对方发 PPU- 开头的完整串」；
 * - 密码模式不提供手打 52 位设备号——手机键盘上抄 52 位必然抄错，
 *   要么已配对（列表里选），要么扫码/完整串。
 *
 * 凭证才是天花板：一律申请「可控」，被控端会压档并回传真实档（桌面同语义）。
 */
import { useMemo, useState } from "react";
import { fingerprintOf } from "@/lib/fingerprint";
import { parseUnoInput, unoCodeShapeOk, unoPassCharsOk } from "@/lib/rcUno";
import type { UseRc } from "@/hooks/useRc";
import { RcScanOverlay } from "./RcScanOverlay";
import { useQrScan } from "./useQrScan";
import styles from "./RcDevices.module.css";

type CredMode = "code" | "pass";

export function RcUnoJoinCard({
  rc,
  fixedTarget,
  onClose,
  onConnected,
}: {
  rc: UseRc;
  /** 从设备动作面板进来时已锁定目标（node_id）；独立入口为 null。 */
  fixedTarget?: string | null;
  onClose: () => void;
  /** 发起成功（等待卡由设备页的 session 状态接管）。 */
  onConnected: () => void;
}) {
  const [credMode, setCredMode] = useState<CredMode>("code");
  const [input, setInput] = useState("");
  const [pass, setPass] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const targets = rc.targets ?? [];
  const parsed = useMemo(() => (credMode === "code" ? parseUnoInput(input) : null), [credMode, input]);
  const shapeOk = parsed ? unoCodeShapeOk(parsed.code) : true;
  const passOk = credMode === "pass" && unoPassCharsOk(pass);

  // 目标三来源（优先级）：面板锁定的 > 完整串自带的 > 列表里认的
  const target = fixedTarget ?? parsed?.nodeId ?? picked;
  const targetName = targets.find((t) => t.node_id === target)?.display_name ?? "";
  const isSelf = !!target && target === rc.identity?.node_id;
  // 裸码/密码没有定位，又没锁定目标：要在列表里认机器
  const needPick = !fixedTarget && !parsed?.nodeId;
  const canConnect =
    !busy &&
    !isSelf &&
    !!target &&
    (credMode === "code" ? !!parsed && shapeOk : passOk) &&
    (!needPick || !!picked || !!parsed?.nodeId);

  const onScanned = (text: string) => {
    setScanning(false);
    const p = parseUnoInput(text);
    if (!p) {
      setErr("扫到的不是无人值守码（应是 8 位码或 PPU- 开头的完整串）。");
      return;
    }
    setErr("");
    setInput(text);
  };

  const connect = async () => {
    if (!target) return;
    setBusy(true);
    setErr("");
    try {
      const ok =
        credMode === "code"
          ? parsed && (await rc.requestUno(target, parsed.code, "control"))
          : await rc.requestPass(target, pass.trim(), "control");
      if (ok) {
        onConnected();
        return;
      }
      // ❗ 读 getState()——闭包里的 rc 是点击那一帧的快照（桌面 JoinPane 同款教训）
      const { useRcStore } = await import("@/stores/rcStore");
      setErr(useRcStore.getState().error ?? "发起失败");
    } finally {
      setBusy(false);
    }
  };

  if (scanning) {
    return (
      <div className={styles.pairCard}>
        <RcScanOverlay onFound={onScanned} onClose={() => setScanning(false)} />
      </div>
    );
  }

  return (
    <div className={styles.pairCard}>
      <div className={styles.pairHint}>凭接入码或密码直连无人值守的电脑（电脑前不用有人确认）</div>

      <div className={styles.unoModes} role="radiogroup" aria-label="凭证类型">
        <button
          type="button"
          role="radio"
          aria-checked={credMode === "code"}
          className={`${styles.peerChip} ${credMode === "code" ? styles.peerChipOn : ""}`}
          onClick={() => setCredMode("code")}
        >
          接入码（对方提前发给你）
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={credMode === "pass"}
          className={`${styles.peerChip} ${credMode === "pass" ? styles.peerChipOn : ""}`}
          onClick={() => setCredMode("pass")}
        >
          固定密码（长期值守的机器）
        </button>
      </div>

      {credMode === "code" ? (
        <>
          <textarea
            className={styles.unoInput}
            aria-label="无人值守接入码"
            placeholder="粘贴 8 位码（7K2M-9PQX）或完整串（PPU- 开头）"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setErr("");
            }}
          />
          <button type="button" className={styles.ghostBtn} onClick={() => setScanning(true)}>
            扫一扫（扫电脑上出示的码）
          </button>
          {input.trim() && !parsed && (
            <div className={styles.noticeError} role="alert">
              认不出无人值守码：请粘 8 位展示码或 PPU- 开头的完整串。
            </div>
          )}
          {parsed && !shapeOk && (
            <div className={styles.noticeError} role="alert">
              码里有无效字符（0/O、1/I/L 会自动纠正；其余请核对原码）。
            </div>
          )}
          {parsed?.nodeId && (
            <div className={styles.unoFp}>机器指纹 {fingerprintOf(parsed.nodeId)}</div>
          )}
        </>
      ) : (
        <input
          type="password"
          className={styles.unoInput}
          aria-label="对方的固定密码"
          placeholder="对方设置的固定密码"
          value={pass}
          onChange={(e) => {
            setPass(e.target.value);
            setErr("");
          }}
        />
      )}

      {/* 密码模式必须填设备号；手机上不让人手打 52 位——从已配对设备里认 */}
      {(credMode === "pass" || (credMode === "code" && needPick)) && (
        <div className={styles.unoPickBlock}>
          <div className={styles.unoFp}>
            {fixedTarget
              ? `连接对象：${targetName || "已锁定"}`
              : credMode === "pass"
                ? "选要连的电脑（固定密码按机器生效）："
                : "裸码不带机器定位，从配对过的电脑里认："}
          </div>
          {fixedTarget ? null : targets.length === 0 ? (
            <div className={styles.noticeError} role="alert">
              还没有配对过的电脑。让对方发 PPU- 开头的完整串（可扫），或先回「设备」页配对。
            </div>
          ) : (
            <div className={styles.peerPick} role="radiogroup" aria-label="选择电脑">
              {targets.map((t) => (
                <button
                  key={t.node_id}
                  type="button"
                  role="radio"
                  aria-checked={picked === t.node_id}
                  className={`${styles.peerChip} ${picked === t.node_id ? styles.peerChipOn : ""}`}
                  onClick={() => setPicked(t.node_id)}
                >
                  {t.display_name || t.name} · {fingerprintOf(t.node_id)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {isSelf && (
        <div className={styles.noticeError} role="alert">
          这是本机自己，连自己是没有用的。
        </div>
      )}
      {err && (
        <div className={styles.noticeError} role="alert">
          {err}
        </div>
      )}

      <button type="button" className={styles.primaryBtn} disabled={!canConnect} onClick={() => void connect()}>
        {busy ? "发起中…" : "连接"}
      </button>
      <div className={styles.dirHint}>
        连上即视为普通配对会话：对方屏幕会出现常驻横幅，随时可以结束。
      </div>
      <button type="button" className={styles.ghostBtn} onClick={onClose}>
        返回
      </button>
    </div>
  );
}
