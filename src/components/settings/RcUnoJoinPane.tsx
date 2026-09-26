/**
 * RcUnoJoinPane — 无人值守「发起端收码直连」那一页。
 *
 * 从 RcUnoDialog.tsx 拆出（组件 ≤300 行红线）。两种凭证（方案 B 码 /
 * 方案 C 密码）粘上来直连：完整串直接发；裸码 / 留空设备号要在附近设备
 * 里认出那台机器（仅限同一局域网）。
 */
import { useEffect, useMemo, useState } from "react";
import { fingerprintOf } from "@/lib/fingerprint";
import {
  nodeIdShapeOk,
  parseUnoInput,
  unoCodeShapeOk,
  unoPassCharsOk,
} from "@/lib/rcUno";
import { useRcStore } from "@/stores/rcStore";
import { rcNearbyStatus, type RcNeighbor } from "@/lib/api/rcPair";
import type { UseRc } from "@/hooks/useRc";
import type { ToastFn } from "@/components/Toast";
import { RcCredTag } from "./RcCredTag";
import styles from "../rc/RemoteComputer.module.css";

export function JoinPane({ rc, toast, onClose }: { rc: UseRc; toast: ToastFn; onClose: () => void }) {
  const [credMode, setCredMode] = useState<"code" | "pass">("code");
  const [input, setInput] = useState("");
  const [pass, setPass] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [neighbors, setNeighbors] = useState<RcNeighbor[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const parsed = useMemo(() => (credMode === "code" ? parseUnoInput(input) : null), [credMode, input]);
  // 形状检查（字符集/长度）：O/I/L 会自动纠正，U 之类无效字符就地拦下，
  // 别等对面机器摘要比对才报错（2026-09-19 审查：这层防线此前没接线）
  const shapeOk = parsed ? unoCodeShapeOk(parsed.code) : true;
  // 密码模式：长度先挡一道（按字符数，与后端 unop 同口径——见 unoPassCharsOk）
  const passOk = credMode === "pass" && unoPassCharsOk(pass);
  const nodeIdBad = credMode === "pass" && nodeId.trim() !== "" && !nodeIdShapeOk(nodeId);
  // 裸码没有 node_id / 密码模式没填设备号：同一局域网时从附近设备列表里认出对方
  const needNearby =
    credMode === "code"
      ? !!parsed && shapeOk && !parsed.nodeId
      : passOk && nodeId.trim() === "" && !nodeIdBad;
  const selfId = rc.identity?.node_id;

  useEffect(() => {
    if (!needNearby) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await rcNearbyStatus();
        if (alive) setNeighbors(s.neighbors);
      } catch {
        // 界面轮询失败不吵用户：列表为空本身就是明确的指引
      }
    };
    void tick();
    const t = window.setInterval(tick, 2000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [needNearby]);

  const target = credMode === "code" ? (parsed?.nodeId ?? picked) : nodeId.trim() || picked;
  const isSelf = !!target && target === selfId;
  const connect = async () => {
    setBusy(true);
    try {
      // 一律申请「可控」：凭证才是真正的天花板，被控端会压档并回传真实档。
      const ok =
        credMode === "code"
          ? parsed && target
            ? await rc.requestUno(target, parsed.code, "control")
            : false
          : target
            ? await rc.requestPass(target, pass.trim(), "control")
            : false;
      if (ok) {
        toast("已发起连接：等对方接通…", "success");
        onClose();
      } else {
        // run() 把失败原因收进了 store.error，这里就地摆出来：
        // 用户正盯着输入框，错误不该藏在弹层底下的页面里。
        // ❗ 读 getState()——闭包里的 rc 是点击那一帧的快照，await 期间
        //    store 才写入的 error 它看不见。
        setErr(useRcStore.getState().error ?? "发起失败");
      }
    } finally {
      setBusy(false);
    }
  };

  const canConnect =
    credMode === "code"
      ? !!parsed && shapeOk && !!target && !isSelf
      : passOk && !nodeIdBad && !!target && !isSelf;

  return (
    <>
      <div className={styles.unoStack}>
        <label className={styles.unoRowTop}>
          <input
            type="radio"
            checked={credMode === "code"}
            onChange={() => {
              setCredMode("code");
              setPicked(null);
              setErr("");
            }}
          />
          <span>
            <b>无人值守码</b> <RcCredTag tone="uno" label="对面没人" />
            <span className={`${styles.foot} ${styles.unoBlockSpan}`}>
              15 分钟 / 24 小时有效的接入码，对方提前发给你
            </span>
          </span>
        </label>
        <label className={styles.unoRowTop}>
          <input
            type="radio"
            checked={credMode === "pass"}
            onChange={() => {
              setCredMode("pass");
              setPicked(null);
              setErr("");
            }}
          />
          <span>
            <b>固定密码</b> <RcCredTag tone="uno" label="长期值守" />
            <span className={`${styles.foot} ${styles.unoBlockSpan}`}>
              用于长期挂机的机器（自家服务器 / 出租机）
            </span>
          </span>
        </label>
      </div>
      <div className={`${styles.foot} ${styles.unoFootGap}`}>
        对方<b>有人在场</b>？改用「帮助 → 帮别人连一次」，那边当场确认。
      </div>
      {credMode === "code" ? (
        <>
          <textarea
            className={styles.unoTextarea}
            placeholder="粘贴无人值守码（7K2M-9PQX）或完整码（PPU-开头）"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setPicked(null);
              setErr("");
            }}
          />
          {input.trim() && !parsed && (
            <div className={styles.noteBad}>
              认不出无人值守码：请粘 8 位展示码（如 7K2M-9PQX）或完整码（PPU-开头）。
            </div>
          )}
          {parsed && !shapeOk && (
            <div className={styles.noteBad}>
              无人值守码里有无效字符（0/O、1/I/L 会自动纠正；其余请核对原码）。
            </div>
          )}
          {parsed?.nodeId && (
            <div className={styles.foot}>
              设备指纹 <b>{fingerprintOf(parsed.nodeId)}</b>
              {isSelf && "（这是本机自己，连自己是没有用的）"}
            </div>
          )}
        </>
      ) : (
        <>
          <input
            type="password"
            className={styles.unoInput}
            placeholder="对方设置的固定密码"
            value={pass}
            onChange={(e) => {
              setPass(e.target.value);
              setPicked(null);
              setErr("");
            }}
          />
          <input
            className={styles.unoMonoInput}
            placeholder="对方的设备号（同一局域网可留空，在下面认）"
            value={nodeId}
            onChange={(e) => {
              setNodeId(e.target.value);
              setPicked(null);
              setErr("");
            }}
          />
          {nodeIdBad && <div className={styles.noteBad}>设备号应该是 52 位编码，请核对（设置页「设备号」一栏）。</div>}
          {nodeId.trim() && nodeIdShapeOk(nodeId) && (
            <div className={styles.foot}>
              设备指纹 <b>{fingerprintOf(nodeId.trim())}</b>
              {isSelf && "（这是本机自己，连自己是没有用的）"}
            </div>
          )}
        </>
      )}
      {needNearby && (
        <div className={styles.foot}>
          {credMode === "code" ? "裸码不带设备号" : "没填设备号"}
          ——在下面认出对方的机器（仅限同一局域网）；不在列表里就请对方发
          {credMode === "code" ? <b>完整接入串</b> : <b>设备号</b>}。
          {neighbors.length === 0 && <div className={styles.noteWarn}>附近没发现设备…</div>}
          {neighbors.map((n) => (
            <label key={n.node_id} className={styles.unoRow}>
              <input
                type="radio"
                name="uno-neighbor"
                checked={picked === n.node_id}
                onChange={() => setPicked(n.node_id)}
              />
              <span>
                {n.name || "未命名设备"} · 指纹 {fingerprintOf(n.node_id)}
              </span>
            </label>
          ))}
        </div>
      )}
      {(credMode === "code" ? parsed : passOk) && !isSelf && target && (
        <div className={styles.foot}>
          连上即视为普通配对设备：对方屏幕会出现常驻横幅，随时可以结束。
        </div>
      )}
      {err && <div className={styles.noteBad}>{err}</div>}
      <div className={styles.unoActs}>
        <button type="button" className={styles.miniBtn} onClick={onClose}>
          返回
        </button>
        <button type="button" className={styles.miniBtnPri} disabled={!canConnect || busy} onClick={() => void connect()}>
          连接
        </button>
      </div>
    </>
  );
}
