/**
 * RcFileAsk — 文件传输的**确认条**（G6，B4）。被控端专用，两种形态渲染同一份状态。
 *
 * | 场景 | 形态 | 谁用 |
 * |---|---|---|
 * | 被控抽屉展开态 | 完整卡片：文件名/大小/来源指纹/目标位置/接受·拒绝 | `RcControlBanner` |
 * | 胶囊条上（抽屉自动展开兜底） | 一行摘要 + 接受/拒绝 | `RcFileOverlay` / 无会话常驻分支 |
 *
 * # 两条不能省的纪律
 *
 * 1. **两个方向的按钮含义完全不同**（`askPrompt` 已分开写）：push = 接受落盘，
 *    pull = 我要选「发哪个」。共用一句文案会让用户点出最坏后果——把自家文件发出去。
 * 2. 🔴 2026-09-27（用户拍板：不再每次弹目录选择框）：push 的「接受」直接落
 *    **接收目录**（`rc_file_default_dir`，设置里可改）；「选其他位置」降为次级
 *    小钮，保留「这次就想放别处」的能力。pull 方向仍是选文件（那一步不能省）。
 *    旧纪律「接受必须选完路径才回响应」只对「其他位置」路径成立——主路径的
 *    落点由设置决定，不需要用户再确认一次。
 *
 * 3. **「以后自动接收」勾选只在 push 上出现**（B6 落地）。pull 方向是「我要把哪个
 *    文件发出去」，没有可自动的东西——摆在那里就是个语义含糊的假开关。
 *    勾上之后不再询问：以后那些也落**同一个接收目录**（设置里可改）。
 *
 * ❗ 勾选**只跳确认条，不跳门禁**：`gate_inbound` 仍先跑，被禁用/未配对的设备
 *    照样进不来。这条在后端 `file_transfer.rs::auto_accept_dir` 有注释钉着。
 */
import { useEffect, useId, useState } from "react";
import { fingerprintOf } from "@/lib/fingerprint";
import { rcDeviceAutoAcceptSet } from "@/lib/api/rc";
import { rcFileDefaultDir } from "@/lib/api/rcFile";
import { ASK_TIMEOUT_MS, askCountdown, askPrompt, formatBytes } from "@/lib/rcFile";
import type { RcFileAsk } from "@/lib/api/rcFile";
import styles from "./RemoteComputer.module.css";

/** 打开系统选择框，拿到用户选定的路径（取消 → null）。「其他位置」次级路径专用。 */
async function pickAccept(ask: RcFileAsk): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  if (ask.kind === "push") {
    // 默认目录由 Rust 给（中文系统的下载目录叫「下载」，还可能被重定向）
    let defaultPath: string | undefined;
    try {
      defaultPath = await rcFileDefaultDir();
    } catch {
      /* 拿不到就让用户自己找，不拦着 */
    }
    const dir = await open({
      directory: true,
      multiple: false,
      title: "选择保存位置",
      defaultPath,
    });
    return typeof dir === "string" ? dir : null;
  }
  // pull：一次只发一个文件（后端 accept 帧带单条 name/size），所以不开放多选
  const file = await open({ directory: false, multiple: false, title: "选择要发送的文件" });
  return typeof file === "string" ? file : null;
}

/**
 * 接收落点（push 主路径）：直接用 `rc_file_default_dir`——设置里可改的
 * 「文件接收目录」，未配置回落 `<下载>/PastePanda 接收`。拿不到（后端异常）
 * 才返回 null，由调用方退回「其他位置」弹框，别让「点了接受什么也没发生」。
 */
async function receiveDir(): Promise<string | null> {
  try {
    return await rcFileDefaultDir();
  } catch {
    return null;
  }
}

/** 卡片与一行版共用的交互（接受/其他位置 → 回响应 → 失败可重试）。 */
function useAskActions(
  ask: RcFileAsk,
  onRespond: (askId: string, acceptDir: string | null) => Promise<boolean>,
) {
  const [picking, setPicking] = useState(false);
  const [failed, setFailed] = useState(false);
  /** 勾选「以后自动接收此设备的文件」——只对 push 有意义（见文件头纪律 3）。 */
  const [auto, setAuto] = useState(false);
  /** 勾了、也接受了，但**没写进设备记录**。必须说出来：否则用户以为已经免问，下次又弹。 */
  const [autoFailed, setAutoFailed] = useState(false);
  const canAuto = ask.kind === "push";

  const respond = async (path: string | null) => {
    const ok = await onRespond(ask.id, path);
    if (!ok) {
      setFailed(true);
      return false;
    }
    if (auto && canAuto) {
      try {
        await rcDeviceAutoAcceptSet(ask.peer, true);
      } catch {
        setAutoFailed(true);
      }
    }
    return true;
  };

  /** 主路径：push 直接落接收目录（不弹框）；pull 仍去选文件。 */
  const accept = async () => {
    if (picking) return;
    setPicking(true);
    setFailed(false);
    setAutoFailed(false);
    try {
      let path: string | null;
      if (ask.kind === "push") {
        path = await receiveDir();
        if (!path) path = await pickAccept(ask); // 退路：别让「点了接受什么也没发生」
      } else {
        path = await pickAccept(ask);
      }
      // 取消了系统选择框（pull / 其他位置）= 不回应：让请求走 60s 超时（等价拒绝），
      // 不能替用户回一个他没选过的路径。
      if (!path) return;
      await respond(path);
    } catch {
      setFailed(true);
    } finally {
      setPicking(false);
    }
  };

  /** 次级路径（push 专属）：「这次就想放别处」——弹系统选择框，落用户选的目录。 */
  const pickOther = async () => {
    if (picking || ask.kind !== "push") return;
    setPicking(true);
    setFailed(false);
    setAutoFailed(false);
    try {
      const path = await pickAccept(ask);
      if (!path) return;
      await respond(path);
    } catch {
      setFailed(true);
    } finally {
      setPicking(false);
    }
  };

  return {
    picking,
    failed,
    auto,
    setAuto,
    autoFailed,
    canAuto,
    accept: () => void accept(),
    pickOther: () => void pickOther(),
    deny: () => void onRespond(ask.id, null),
  };
}

/** 每秒一跳的本地时钟（倒计时用；ask 换 id 时重建）。 */
function useTick(id: string): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [id]);
  return now;
}

/**
 * 完整卡片（工作台）。
 *
 * 摆出的都是核对用的事实：谁发的（指纹，不是可自称的名字）、多大的文件、
 * 会落到哪里——「我要不要把盘交出去」的判断依据。
 */
export function RcFileAskCard({
  ask,
  busy,
  onRespond,
}: {
  ask: RcFileAsk;
  busy: boolean;
  onRespond: (askId: string, acceptDir: string | null) => Promise<boolean>;
}) {
  const now = useTick(ask.id);
  const p = askPrompt(ask);
  const { remainSec, late } = askCountdown(ask, now);
  const a = useAskActions(ask, onRespond);
  /* 落点说明挂在 `aria-describedby` 上而不是塞进 `<label>`：
     塞进去会让勾选框的无障碍名变成「主文案 + 落点说明」一长串（屏幕阅读器念不完、
     测试也锚不住）。拆开之后名字仍是干净的一句，说明照样会被念出来。 */
  const autoHintId = useId();
  /** 接收落点（push 才有意义）：展示「存到哪儿」这个核对事实。 */
  const [recvDir, setRecvDir] = useState("");
  useEffect(() => {
    if (ask.kind !== "push") return;
    let alive = true;
    void receiveDir().then((d) => {
      if (alive && d) setRecvDir(d);
    });
    return () => {
      alive = false;
    };
  }, [ask.id, ask.kind]);

  return (
    <div className={styles.fileAskCard} role="alertdialog" aria-live="assertive">
      <div className={styles.fileAskHead}>
        <span className={styles.dotDanger} />
        <span className={styles.fileAskTitle}>{p.title}</span>
        <span className={styles.fileAskKind}>{ask.kind === "push" ? "对方发文件" : "对方要文件"}</span>
      </div>
      <div className={styles.fileAskLead}>{p.lead}</div>
      <dl className={styles.ibFacts}>
        <div className={styles.ibFact}>
          <dt>来源指纹</dt>
          <dd>{fingerprintOf(ask.peer)}</dd>
        </div>
        {ask.kind === "push" && (
          <>
            <div className={styles.ibFact}>
              <dt>文件名</dt>
              <dd className={styles.fileAskMono}>{ask.name}</dd>
            </div>
            <div className={styles.ibFact}>
              <dt>大小</dt>
              <dd>{formatBytes(ask.size)}</dd>
            </div>
            {recvDir && (
              <div className={styles.ibFact}>
                <dt>保存到</dt>
                <dd className={styles.fileAskMono} title={recvDir}>
                  {recvDir}
                </dd>
              </div>
            )}
          </>
        )}
      </dl>
      {/* 只在 push 上给：pull 是「我要发哪个」，没有可自动的东西（文件头纪律 3）。 */}
      {/* 文案里的目录名对应后端 `default_receive_dir()`——那边改了这里要跟着改。 */}
      {a.canAuto && (
        <>
          <label className={styles.fileAskAuto}>
            <input
              type="checkbox"
              checked={a.auto}
              disabled={busy || a.picking}
              aria-describedby={autoHintId}
              onChange={(e) => a.setAuto(e.target.checked)}
            />
            <span>以后自动接收此设备的文件</span>
          </label>
          <div id={autoHintId} className={styles.fileAskAutoHint}>
            存到文件接收目录（设置里可改），随时可在设备卡片上撤销
          </div>
        </>
      )}
      <div className={styles.fileAskActions}>
        <span className={late ? styles.fileAskCdLate : styles.fileAskCd} role="status">
          {remainSec > 0 ? `需在 ${remainSec}s 内回应` : "即将超时（超时视为拒绝）"}
        </span>
        {a.failed && <span className={`${styles.fb} ${styles.fbBad}`}>回应失败，请重试</span>}
        {a.autoFailed && (
          <span className={`${styles.fb} ${styles.fbBad}`}>
            已接收，但「自动接收」没存上，下次仍会询问
          </span>
        )}
        <span className={styles.sp} />
        <button type="button" className={styles.miniBtn} disabled={busy || a.picking} onClick={a.deny}>
          {p.deny}
        </button>
        {/* push 主路径直接落接收目录（不再弹选框）；「其他位置」是次级出口——
            这次想放别处才用，落点仍是接受那刻就定死的。 */}
        {ask.kind === "push" && (
          <button
            type="button"
            className={styles.miniBtn}
            disabled={busy || a.picking}
            title="这次把文件存到你指定的位置"
            onClick={a.pickOther}
          >
            其他位置
          </button>
        )}
        <button
          type="button"
          className={styles.dangerBtn}
          disabled={busy || a.picking}
          title={p.lead}
          onClick={a.accept}
        >
          {a.picking ? "等待选择…" : p.accept}
        </button>
      </div>
      <div className={styles.fileAskNote}>
        超时（{ASK_TIMEOUT_MS / 1000}s 内不回应）会自动拒绝，不会静默接收。
      </div>
    </div>
  );
}

/**
 * 一行摘要（主窗常驻横幅）。
 *
 * 「人不在工作台也得看得见」是规则 15 的原话——但它只有一行的地方，
 * 所以只留：谁 + 干什么 + 倒计时 + 两个按钮。点接受后系统选择框是**模态**的，
 * 不受主窗口焦点影响，从这里也走得通同一条交互。
 */
export function RcFileAskLine({
  ask,
  busy,
  onRespond,
}: {
  ask: RcFileAsk;
  busy: boolean;
  onRespond: (askId: string, acceptDir: string | null) => Promise<boolean>;
}) {
  const now = useTick(ask.id);
  const p = askPrompt(ask);
  const { remainSec, late } = askCountdown(ask, now);
  const a = useAskActions(ask, onRespond);

  return (
    <span className={styles.fileAskLine} role="alert">
      <b>{p.title}</b>
      {/* U3：一行版也要能看到「是什么文件」——倒计时催人 60s 内回应，
          却不给文件名/大小，用户只能盲点。 */}
      {ask.name && (
        <span className={styles.fileAskName} title={ask.name}>
          {ask.name}（{formatBytes(ask.size)}）
        </span>
      )}
      <span className={late ? styles.fileAskCdLate : styles.fileAskCd}>{remainSec}s</span>
      {a.failed && <span className={`${styles.fb} ${styles.fbBad}`}>回应失败</span>}
      <button type="button" className={styles.miniBtn} disabled={busy || a.picking} onClick={a.deny}>
        {p.deny}
      </button>
      <button
        type="button"
        className={styles.miniBtnPri}
        disabled={busy || a.picking}
        title={p.lead}
        onClick={a.accept}
      >
        {a.picking ? "…" : p.accept}
      </button>
    </span>
  );
}
