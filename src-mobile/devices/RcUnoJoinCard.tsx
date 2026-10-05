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
import { useId, useMemo, useState } from "react";
import { fingerprintOf } from "@/lib/fingerprint";
import { parseUnoInput, unoCodeShapeOk, unoPassCharsOk, UNO_PASS_MIN_CHARS, UNO_PASS_MAX_CHARS } from "@/lib/rcUno";
import { rcDisplayName } from "@/lib/rcDevice";
import { RcDeviceMeta } from "@/components/rc/RcDeviceMeta";
import { RcDeviceIcon } from "@/components/rc/RcDeviceIcon";
import type { UseRc } from "@/hooks/useRc";
import { RcScanOverlay } from "./RcScanOverlay";
import { MobileNotice } from "../ui/MobileNotice";
import { rcErrorText } from "./rcErrorText";
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
  const [showPass, setShowPass] = useState(false);
  const passHintId = useId();
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
  const targetInfo = targets.find((t) => t.node_id === target);
  const targetName = targetInfo ? rcDisplayName(targetInfo) : "未配对设备";
  const isSelf = !!target && target === rc.identity?.node_id;
  // 裸码/密码没有定位，又没锁定目标：要在列表里认机器
  const needPick = !fixedTarget && !parsed?.nodeId;
  const canConnect =
    !busy && !rc.busy && rc.status?.enabled !== false &&
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
    if (!canConnect || !target) return;
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
    } catch (error) {
      setErr(rcErrorText(error));
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
          disabled={busy}
          className={`${styles.peerChip} ${credMode === "code" ? styles.peerChipOn : ""}`}
          onClick={() => setCredMode("code")}
        >
          接入码（对方提前发给你）
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={credMode === "pass"}
          disabled={busy}
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
            disabled={busy}
            onChange={(e) => {
              setInput(e.target.value);
              setErr("");
            }}
          />
          <button type="button" className={styles.ghostBtn} disabled={busy} onClick={() => setScanning(true)}>
            扫一扫（扫电脑上出示的码）
          </button>
          {input.trim() && !parsed && (
            <MobileNotice error compact>
              认不出无人值守码：请粘 8 位展示码或 PPU- 开头的完整串。
            </MobileNotice>
          )}
          {parsed && !shapeOk && (
            <MobileNotice error compact>
              码里有无效字符（0/O、1/I/L 会自动纠正；其余请核对原码）。
            </MobileNotice>
          )}
          {parsed?.nodeId && (
            <div className={styles.unoFp}>机器指纹 {fingerprintOf(parsed.nodeId)}</div>
          )}
        </>
      ) : (
        <>
        <input
          type={showPass ? "text" : "password"}
          className={styles.unoInput}
          aria-label="对方的固定密码"
          aria-describedby={passHintId}
          aria-invalid={!!pass && !passOk}
          autoComplete="current-password"
          disabled={busy}
          placeholder="对方设置的固定密码"
          value={pass}
          onChange={(e) => {
            setPass(e.target.value);
            setErr("");
          }}
        />
        <button type="button" className={styles.ghostBtn} disabled={busy} aria-pressed={showPass} onClick={() => setShowPass((value) => !value)}>
          {showPass ? "隐藏密码" : "显示密码"}
        </button>
        <div id={passHintId}>{pass && !passOk ? <MobileNotice error compact>{`密码长度不符合要求，请输入 ${UNO_PASS_MIN_CHARS}～${UNO_PASS_MAX_CHARS} 个字符。`}</MobileNotice> : <p className={styles.dirHint}>{`密码需为 ${UNO_PASS_MIN_CHARS}～${UNO_PASS_MAX_CHARS} 个字符。`}</p>}</div>
        </>
      )}

      {target && <div className={styles.unoFp}>连接对象：{targetName}{targetInfo && <RcDeviceMeta os={targetInfo.os} />}</div>}

      {/* 密码模式必须填设备号；手机上不让人手打 52 位——从已配对设备里认 */}
      {!fixedTarget && needPick && (
        <div className={styles.unoPickBlock}>
          <div className={styles.unoFp}>
            {credMode === "pass" ? "请选择设置了此密码的设备：" : "这枚接入码未包含设备信息，请选择连接对象："}
          </div>
          {targets.length === 0 ? (
            <MobileNotice>
              还没有配对过的电脑。让对方发 PPU- 开头的完整串（可扫），或先回「设备」页配对。
            </MobileNotice>
          ) : (
            <div className={styles.peerPick} role="radiogroup" aria-label="选择设备">
              {targets.map((t) => (
                <button
                  key={t.node_id}
                  type="button"
                  role="radio"
                  aria-label={rcDisplayName(t)}
                  aria-checked={picked === t.node_id}
                  disabled={busy}
                  className={`${styles.peerChip} ${picked === t.node_id ? styles.peerChipOn : ""}`}
                  onClick={() => setPicked(t.node_id)}
                >
                  <RcDeviceIcon os={t.os} size={34} />
                  <span className={styles.peerDetails}><strong>{rcDisplayName(t)}</strong><RcDeviceMeta os={t.os} className={styles.deviceType} /><small>{fingerprintOf(t.node_id)}</small></span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {isSelf && (
        <MobileNotice error compact>
          这是本机，请选择其他设备。
        </MobileNotice>
      )}
      {err && (
        <MobileNotice error title="未能连接无人值守电脑" detail={rcErrorText(err)} onDismiss={() => setErr("")} />
      )}
      {rc.status?.enabled === false && <MobileNotice tone="warning">请先在设置中开启远程通道。</MobileNotice>}
      {!target && targets.length > 0 && <p className={styles.dirHint}>请先选择要连接的设备。</p>}

      <button type="button" className={styles.primaryBtn} disabled={!canConnect} onClick={() => void connect()}>
        {busy ? "发起中…" : "连接"}
      </button>
      <div className={styles.dirHint}>
        连上即视为普通配对会话：对方屏幕会出现常驻横幅，随时可以结束。
      </div>
      <button type="button" className={styles.ghostBtn} disabled={busy} onClick={onClose}>
        返回
      </button>
    </div>
  );
}
