/**
 * RcUnoDialog — 无人值守接入（Q2 方案 B）的弹层，两种立场共用一个壳：
 *
 * - `generate`（被控端）：选时效 / 能力档 / 免确认 → 出码。
 *   展示码 `XXXX-XXXX` 给电话念，完整接入串 `PPU-<码>-<node_id>` 给复制粘贴
 *   （跨网时对方必须连 node_id 一起拿到，8 位码定位不了机器）。
 * - `join`（发起端）：粘贴接入串或裸码 → 直接连。完整串直接发；
 *   裸码只能在本机「听得到」对方组播（同一局域网）时用——靠附近设备
 *   列表补上 node_id，列表里没有就明确说「请让对方发完整串」。
 *
 * # 为什么不进 RcAdhocDialog 的壳
 *
 * 一次性协助（方案甲）两端都**有人**，语义是「这次」；无人值守的语义是
 * 「对面没人，码就是授权」。两套话术（「用完即弃」vs「码会过期」）不该
 * 挤在同一个组件里各说各话，与 RcAdhocDialog ≠ RcPairDialog 同一个理由。
 *
 * # 能力档在生成端定，发起端一律申请「可控」
 *
 * 发起端不知道码授的是哪一档（码是摘要可比的乱码），所以总是申请最大档，
 * 由被控端压到码的档位并随 Accept 回传——会话 UI 按真实档渲染，
 * 与「提权为可控」的既有语义一致。
 */
import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { X } from "lucide-react";
import { FocusTrap } from "@/components/FocusTrap";
import { useDialogAnim } from "@/lib/dialogMotion";
import { fingerprintOf } from "@/lib/fingerprint";
import { parseUnoInput, unoCodeShapeOk } from "@/lib/rcUno";
import { useRcStore } from "@/stores/rcStore";
import { rcNearbyStatus, type RcNeighbor } from "@/lib/api/rcPair";
import type { UseRc } from "@/hooks/useRc";
import type { ToastFn } from "@/components/Toast";
import styles from "../rc/RemoteComputer.module.css";

export type UnoSide = "generate" | "join";

const TTL_SHORT_SECS = 15 * 60;
const TTL_DAY_SECS = 24 * 60 * 60;

export function RcUnoDialog({
  rc,
  toast,
  side,
  onClose,
}: {
  rc: UseRc;
  toast: ToastFn;
  side: UnoSide;
  onClose: () => void;
}) {
  const anim = useDialogAnim();
  return (
    <motion.div key="rc-uno" {...anim.backdrop} className="dialog-backdrop" onClick={onClose}>
      <FocusTrap>
        <motion.div
          {...anim.panel}
          className="dialog-box"
          style={{ width: "min(480px, 94vw)" }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="dialog-header">
            <h2 className="dialog-title">{side === "generate" ? "无人值守接入码" : "有接入码？直接连"}</h2>
            <button className="dialog-close" onClick={onClose} aria-label="关闭">
              <X size={15} />
            </button>
          </div>
          <div className={styles.body}>
            {side === "generate" ? <GeneratePane rc={rc} toast={toast} onClose={onClose} /> : <JoinPane rc={rc} toast={toast} onClose={onClose} />}
          </div>
        </motion.div>
      </FocusTrap>
    </motion.div>
  );
}

/** 被控端：出码。码只在生成那一刻可见，关掉弹层就再也找不回来（刻意的）。 */
function GeneratePane({ rc, toast, onClose }: { rc: UseRc; toast: ToastFn; onClose: () => void }) {
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
    return (
      <>
        <div className={styles.foot}>
          对方不在电脑前也能帮你连：生成一个<b>一次性接入码</b>，对方粘贴后自动配对并连入。
          码不落盘，关机即全作废；接入全程有横幅、有记录。
        </div>
        <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0" }}>
          <input type="radio" checked={ttl === "short"} onChange={() => setTtl("short")} />
          <span>15 分钟 · 限 1 次（默认，帮人修电脑）</span>
        </label>
        <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0" }}>
          <input type="radio" checked={ttl === "day"} onChange={() => setTtl("day")} />
          <span>24 小时 · 不限次（装机 / 挂机，可随时撤销）</span>
        </label>
        <div className={styles.foot}>接入后对方可以：</div>
        <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0" }}>
          <input type="radio" checked={cap === "control"} onChange={() => setCap("control")} />
          <span>可控（能操作键鼠）</span>
        </label>
        <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0" }}>
          <input type="radio" checked={cap === "view"} onChange={() => setCap("view")} />
          <span>只看画面</span>
        </label>
        <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0" }}>
          <input type="checkbox" checked={alsoTrust} onChange={(e) => setAlsoTrust(e.target.checked)} />
          <span>接入后给这台设备开免确认（下次不用再给码；可随时关）</span>
        </label>
        {rc.status && !rc.status.enabled && (
          <div className={styles.noteWarn}>
            本机还没打开「允许被远程协助」——先生成码也行，但对方连不进来。
          </div>
        )}
        {err && <div className={styles.noteBad}>{err}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <button type="button" className={styles.miniBtn} onClick={onClose}>
            返回
          </button>
          <button type="button" className={styles.miniBtnPri} disabled={busy} onClick={() => void generate()}>
            生成接入码
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
      <div className={styles.foot}>把这个码念给对方（或原样发给对方）：</div>
      <div
        style={{
          fontFamily: "ui-monospace, Consolas, monospace",
          fontSize: 26,
          letterSpacing: 2,
          textAlign: "center",
          padding: "14px 0",
          borderRadius: 10,
          background: "var(--card-bg, #f6f7f8)",
          border: "1px solid var(--border-color, #e3e6ea)",
        }}
        aria-label="无人值守接入码"
      >
        {created.code}
      </div>
      <div className={styles.foot}>
        有效期还剩 <b>{leftText}</b>；{ttl === "short" ? "限用 1 次。" : "24 小时内不限次。"}
        对方跨网连接时需要<b>完整接入串</b>（含设备号）：
      </div>
      <div className={styles.pairPane} style={{ wordBreak: "break-all", fontFamily: "ui-monospace, Consolas, monospace", fontSize: 12 }}>
        {created.full}
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
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

/** 发起端：粘码直连。完整串直接发；裸码要在附近设备里认出那台机器。 */
function JoinPane({ rc, toast, onClose }: { rc: UseRc; toast: ToastFn; onClose: () => void }) {
  const [input, setInput] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [neighbors, setNeighbors] = useState<RcNeighbor[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const parsed = useMemo(() => parseUnoInput(input), [input]);
  // 形状检查（字符集/长度）：O/I/L 会自动纠正，U 之类无效字符就地拦下，
  // 别等对面机器摘要比对才报错（2026-09-19 审查：这层防线此前没接线）
  const shapeOk = parsed ? unoCodeShapeOk(parsed.code) : true;
  // 裸码没有 node_id：同一局域网时从附近设备列表里认出对方
  const needNearby = !!parsed && shapeOk && !parsed.nodeId;
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

  const target = parsed?.nodeId ?? picked;
  const isSelf = !!target && target === selfId;
  const connect = async () => {
    if (!parsed || !target) return;
    setBusy(true);
    try {
      // 一律申请「可控」：码才是真正的天花板，被控端会压档并回传真实档。
      const ok = await rc.requestUno(target, parsed.code, "control");
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

  return (
    <>
      <textarea
        style={{
          width: "100%",
          minHeight: 56,
          fontSize: 12,
          fontFamily: "ui-monospace, Consolas, monospace",
          borderRadius: 8,
          border: "1px solid var(--border-color, #e3e6ea)",
          padding: 8,
          resize: "vertical",
          background: "var(--card-bg, #fff)",
          color: "var(--text-primary, #1c1f23)",
        }}
        placeholder="粘贴对方发来的接入码（PPU-XXXX-XXXX-…）或 8 位码"
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
          setPicked(null);
          setErr("");
        }}
      />
      {input.trim() && !parsed && (
        <div className={styles.noteBad}>
          认不出接入码：请粘 8 位展示码（如 7K2M-9PQX）或完整接入串（PPU-开头）。
        </div>
      )}
      {parsed && !shapeOk && (
        <div className={styles.noteBad}>
          接入码里有无效字符（0/O、1/I/L 会自动纠正；其余请核对原码）。
        </div>
      )}
      {parsed?.nodeId && (
        <div className={styles.foot}>
          设备指纹 <b>{fingerprintOf(parsed.nodeId)}</b>
          {isSelf && "（这是本机自己，连自己是没有用的）"}
        </div>
      )}
      {needNearby && (
        <div className={styles.foot}>
          裸码不带设备号——在下面认出对方的机器（仅限同一局域网）；不在列表里就请对方发<b>完整接入串</b>。
          {neighbors.length === 0 && <div className={styles.noteWarn}>附近没发现设备…</div>}
          {neighbors.map((n) => (
            <label key={n.node_id} style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0" }}>
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
      {parsed && !isSelf && target && (
        <div className={styles.foot}>
          连上即视为普通配对设备：对方屏幕会出现常驻横幅，随时可以结束。
        </div>
      )}
      {err && <div className={styles.noteBad}>{err}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
        <button type="button" className={styles.miniBtn} onClick={onClose}>
          返回
        </button>
        <button
          type="button"
          className={styles.miniBtnPri}
          disabled={!parsed || !shapeOk || !target || isSelf || busy}
          onClick={() => void connect()}
        >
          连接
        </button>
      </div>
    </>
  );
}
