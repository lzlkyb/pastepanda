/**
 * RcSessionBar — 会话底部**唯一**一条工具栏（方案 B，2026-09-18）。
 *
 * 收拢之前是三条各自带边框和 `margin-top` 的横条：`RcQualityBar(mode=remote)`
 * 的 qBar + `RcClipboardBar` 的 ctrlBar + `RcStatusBar` 的 statusBar。叠在画面
 * 下方就是「深-浅-深」三条带子，而画质/画面那组在侧栏还有一份**同名同档**的
 * （那条写本机配置、这条立即作用于对方）——用户在同一个窗口里看到两组一模一样的
 * 档位胶囊，只能靠一行 11px 小字区分。
 *
 * 两条口径上的决定：
 * 1. **画质/画面改下拉**。6 档 + N 个画面范围平铺是 500px 宽，底栏塞不下会把
 *    剪贴板挤到第二行；改成「当前档上脸」的下拉后一行放得下，且当前值仍一眼可见。
 *    Q7：对端屏列表由 caps 控制帧上报后，逐屏选项进得了下拉，另配「下一屏」
 *    按钮服务多屏高频轮换。
 * 2. **状态字（键盘/指针/1:1/画面静止）并进右端**。它们原来独占一行，内容却是
 *    几个位数的状态字，单独占一条横条不值。
 *
 * 🔴 这里改的是**对方**（`rcSendInput`），失败必须回滚选中并说明。侧栏那条
 *    local 画质条曾经「点了没反应还说已保存」，同一类谎话不能在新组件里重演。
 *
 * 全屏/适配为什么不在这里：它们渲染在 `.fakeScreen` **内部**，全屏时才会跟画面
 * 一起进全屏态；放到底栏等于全屏后按钮消失（只剩 Esc 能退出）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { rcSendInput, rcSetBitratePct, type RcQuality, type RcCaptureScope } from "@/lib/api/rc";
import { RC_BITRATE_OPTIONS, visibleQualities } from "@/lib/rcQuality";
import { scopeOptions } from "@/lib/rcScope";
import type { FitMode } from "@/lib/rcSessionStats";
import type { UseRc } from "@/hooks/useRc";
import { RcDropdown } from "./RcDropdown";
import { RcClipboardBar } from "./RcClipboardBar";
import { RcFileBar } from "./RcFileBar";
import { RcAudioBar } from "./RcAudioBar";
import styles from "./RemoteComputer.module.css";

type Fb = { kind: "ok" | "bad" | "info"; text: string } | null;

export function RcSessionBar({
  rc,
  canControl,
  quality,
  captureScope,
  bitrate,
  onPickQuality,
  onPickScope,
  onPickBitrate,
  audioOn,
  onToggleAudio,
  clipAuto,
  onToggleClipAuto,
  lastAutoAt,
  autoFail,
  onStatus,
  kbOn,
  pointerLocked,
  fit,
  sizeW,
  frameIdleSec,
}: {
  rc: UseRc;
  canControl: boolean;
  quality: string;
  captureScope: string;
  /** Q5：当前码率倍率（50–200，100 = 跟随链路）。会话建立时后端已把配置值推给对方。 */
  bitrate: number;
  /** 选中即写本地态（画面立刻反映用户意图），失败再回滚。 */
  onPickQuality: (q: RcQuality) => void;
  onPickScope: (s: RcCaptureScope) => void;
  onPickBitrate: (pct: number) => void;
  /** G3：系统声音开关（默认开）。被控端有可见提示。 */
  audioOn: boolean;
  onToggleAudio: () => void;
  clipAuto: boolean;
  onToggleClipAuto: () => void;
  lastAutoAt: number;
  autoFail: number;
  onStatus: (msg: string, kind: "success" | "error" | "info") => void;
  kbOn: boolean;
  pointerLocked: boolean;
  fit: FitMode;
  sizeW: number;
  frameIdleSec: number;
}) {
  const [fb, setFb] = useState<Fb>(null);
  /** G6：文件操作组（传文件 / 取文件 / 进度）要对端 node_id——从会话里取。 */
  const peer = rc.status?.session?.peer ?? "";
  // Q7：会话中显示器列表来自**对端**（caps 控制帧带几何信息），本机的会误导
  // （本机有 3 屏不等于对方有）。旧版本对端没有上报 → 空表，只出两项。
  const peerMonitors = useMemo(
    () => rc.status?.peer_monitors ?? [],
    [rc.status?.peer_monitors],
  );
  const scopes = useMemo(() => scopeOptions(peerMonitors), [peerMonitors]);
  // P1：fps120 档以**被控端**上报的能力为准（caps 控制帧），跑不到的档不出现在菜单里
  const qualities = useMemo(
    () =>
      visibleQualities({
        peerFps120: rc.status?.peer_fps120,
        // Q3/Q4：uhd60 档的判定还要被控端是否支持 HEVC 硬编（缺了它 uhd60 永远被过滤）
        peerHevc: rc.status?.peer_hevc,
      }),
    [rc.status?.peer_fps120, rc.status?.peer_hevc],
  );
  // Q5：码率下拉选项。key 走字符串以复用 RcDropdown 的 string 泛型约束。
  const bitrateOptions = useMemo(
    () => RC_BITRATE_OPTIONS.map((o) => ({ key: String(o.pct), label: o.label, tip: o.tip })),
    [],
  );

  // B3：三个下拉的**最新渲染值**——回滚回调在异步失败后才执行，闭包里的
  // props 是旧快照；回滚前用 ref 判断「UI 还停在本次设置值吗」。
  const qualityRef = useRef(quality);
  const scopeRef = useRef(captureScope);
  const bitrateRef = useRef(bitrate);
  useEffect(() => {
    qualityRef.current = quality;
    scopeRef.current = captureScope;
    bitrateRef.current = bitrate;
  }, [quality, captureScope, bitrate]);

  const remoteSend = async (
    ev: Parameters<typeof rcSendInput>[0],
    restore: () => void,
    okText: string,
  ): Promise<boolean> => {
    setFb({ kind: "info", text: "应用中…" });
    try {
      await rcSendInput(ev);
      setFb({ kind: "ok", text: okText });
      return true;
    } catch (e) {
      restore();
      setFb({ kind: "bad", text: `改档失败：${e}` });
      return false;
    }
  };

  const pickQuality = (k: RcQuality) => {
    if (k === quality) return;
    const was = quality as RcQuality;
    onPickQuality(k);
    void remoteSend(
      { kind: "set_quality", quality: k },
      // B3：只有 UI 还停在**本次**设置值时才回滚——快速连改两档时，先发的
      // 请求失败了，其回滚不能覆盖后一档已落下的乐观值。
      () => {
        if (qualityRef.current === k) onPickQuality(was);
      },
      "画质已同步到对方",
    );
  };

  const pickScope = (k: RcCaptureScope) => {
    if (k === captureScope) return;
    const was = captureScope as RcCaptureScope;
    onPickScope(k);
    void remoteSend(
      { kind: "set_capture_scope", scope: k },
      () => {
        if (scopeRef.current === k) onPickScope(was);
      },
      "画面范围已同步到对方",
    );
  };

  // Q5：码率与画质/画面不同——它是发起端的**偏好**，还要写本机配置，
  // 下一场会话由后端在建立时自动推送（outbound.rs）。远端应用失败必须回滚；
  // 本地保存失败不打断会话（会话内已生效，下次会话回落旧偏好，无害）。
  const pickBitrate = (k: string) => {
    const pct = Number(k);
    if (pct === bitrate) return;
    const was = bitrate;
    onPickBitrate(pct);
    void remoteSend(
      { kind: "set_bitrate_pct", pct },
      () => {
        if (bitrateRef.current === pct) onPickBitrate(was);
      },
      "码率已同步到对方",
    ).then((ok) => {
      if (ok) void rcSetBitratePct(pct).catch(() => {});
    });
  };

  // Q7：「下一屏」——多屏高频操作不想开下拉。在**对端的物理屏**之间循环：
  // 当前在 monitor:N → monitor:(N+1) % 屏数；在整屏/主屏 → monitor:0。
  // 复用 pickScope 的发送 + 回滚链路，行为与下拉选项完全一致。
  const canCycleScreen = peerMonitors.length >= 2;
  const cycleScreen = () => {
    if (!canCycleScreen) return;
    const count = peerMonitors.length;
    const m = /^monitor:(\d+)$/.exec(captureScope);
    const next = m
      ? (`monitor:${(Number(m[1]) + 1) % count}` as RcCaptureScope)
      : ("monitor:0" as RcCaptureScope);
    pickScope(next);
  };

  // 状态字。键盘这条原来在 `RcSessionTop` 有个「键盘：未捕获」胶囊、在 `RcStatusBar`
  // 又有一句「点画面捕获键盘」——两处说的是同一件事。现在只留这里一处，且按能力分档：
  // 「只看」会话捕获键盘没有意义（按键本来就发不过去），不摆这条。
  const stateBits = [
    canControl ? (kbOn ? "键盘已捕获 · Esc 释放" : "点画面可捕获键盘") : "",
    pointerLocked ? "指针已锁定" : "",
    fit === "actual" && sizeW > 0 ? "1:1 可拖动平移" : "",
    frameIdleSec > 0 ? `画面静止 ${frameIdleSec}s` : "",
  ].filter(Boolean);

  const fbCls =
    fb?.kind === "ok" ? styles.fbOk : fb?.kind === "bad" ? styles.fbBad : styles.fbInfo;

  return (
    <div className={styles.sessionBar}>
      {/* v5 分段组合控件（设计稿 B 窗）：画质/画面两格下拉同住一个容器——
          外框由 .segGroup 提供，菜单仍向上弹。 */}
      <span className={styles.segGroup}>
        <RcDropdown
          label="画质"
          value={quality as RcQuality}
          options={qualities}
          // D-2：只看仍可调画质/编码（流控），不改主机采集范围
          disabled={rc.busy}
          onPick={pickQuality}
        />
        <span className={styles.segSep} aria-hidden="true" />
        <RcDropdown
          label="画面"
          value={captureScope as RcCaptureScope}
          options={scopes}
          // D-2 拍板：改画面范围要求可控——只看会切到对方其它屏，属改主机可观测内容
          disabled={rc.busy || !canControl}
          onPick={pickScope}
        />
        {/* Q7：对端有 ≥2 块屏才出「下一屏」；只看同样不可切（与画面下拉同门禁） */}
        {canCycleScreen && (
          <>
            <span className={styles.segSep} aria-hidden="true" />
            <button
              type="button"
              className={styles.menuBtn}
              disabled={rc.busy || !canControl}
              title={
                canControl
                  ? "切换到对方的下一块显示器（循环）"
                  : "只看会话不能改画面范围，需可控会话"
              }
              onClick={cycleScreen}
            >
              下一屏
            </button>
          </>
        )}
        <span className={styles.segSep} aria-hidden="true" />
        <RcDropdown
          label="码率"
          value={String(bitrate)}
          options={bitrateOptions}
          disabled={rc.busy}
          onPick={pickBitrate}
        />
      </span>
      {/* G3 / G3-B / G3-C：声音组（本机开关 + 对方静音的告知 + 静音对方外放）。
          只看会话也该有声音——音频不要求控制权，所以这组摆在剪贴板栏（仅可控）之前，
          两种能力档都看得见。 */}
      <RcAudioBar
        rc={rc}
        canControl={canControl}
        audioOn={audioOn}
        onToggleAudio={onToggleAudio}
        onStatus={onStatus}
      />
      <span className={styles.barSep} />
      {canControl && (
        <>
          <RcClipboardBar
            clipAuto={clipAuto}
            onToggleAuto={onToggleClipAuto}
            lastAutoAt={lastAutoAt}
            autoFail={autoFail}
            onStatus={onStatus}
          />
          {/* G6：文件操作组（传文件 / 取文件 / 进度）。写对端磁盘与「推送剪贴板」
              同级，所以同样在 canControl 门内——「只看」会话不该能往对方机器写文件。 */}
          <RcFileBar peer={peer} />
        </>
      )}
      {fb && <span className={`${styles.fb} ${fbCls}`}>{fb.text}</span>}
      <span className={styles.sp} />
      {stateBits.length > 0 && (
        <span className={styles.barStatus}>{stateBits.join(" · ")}</span>
      )}
    </div>
  );
}
