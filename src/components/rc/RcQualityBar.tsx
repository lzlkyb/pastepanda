/**
 * RcQualityBar — **本机**画质档 + 画面范围（写本机配置，下次生效）。
 *
 * 方案 B（2026-09-18）：删掉 `mode="remote"`（会话中改**对方**画质）那一支。
 * 那一支与这里「写本机配置」是两种完全不同的语义，只是档位名与外形一样；靠一个
 * mode 分支塞在同一个组件里，正是「同一窗口并排两条同构控件、只能靠一行 11px 小字
 * 分辨」的根源。会话中那条现在归 `RcSessionBar` 的两个下拉，并且**失败会回滚**。
 *
 * 于是本组件只剩一个语义：**本机被控画面**（别人看你时的编码档）。所以 `localNote`
 * 从可选变必填——调用方必须就地写明它在改谁。
 */
import { useEffect, useState } from "react";
import { rcListMonitors, rcEncodeCaps, type RcMonitorInfo } from "@/lib/api/rc";
import type { RcQuality, RcCaptureScope } from "@/lib/api/rc";
import { visibleQualities } from "@/lib/rcQuality";
import { scopeOptions } from "@/lib/rcScope";
import type { UseRc } from "@/hooks/useRc";
import styles from "./RemoteComputer.module.css";

type Fb = { kind: "ok" | "bad" | "info"; text: string } | null;

export function RcQualityBar({
  rc,
  quality,
  captureScope,
  disabled,
  localNote,
  onPickQuality,
  onPickScope,
}: {
  rc: UseRc;
  quality: string;
  captureScope: string;
  disabled?: boolean;
  /** 这一条到底在改什么（例如「本机被控画面 · 别人看你时用它」）。必填，见文件头。 */
  localNote: string;
  onPickQuality?: (q: RcQuality) => void;
  onPickScope?: (s: RcCaptureScope) => void;
}) {
  const [fb, setFb] = useState<Fb>(null);
  const [monitors, setMonitors] = useState<RcMonitorInfo[]>([]);
  // P1：本机编码能力——fps120 档只在「硬件 D3D11-aware MFT + 刷新 ≥100Hz」时出现
  const [caps, setCaps] = useState<
    { h264_gpu: boolean; hevc_hw: boolean; refresh_hz: number } | null
  >(null);

  // 本机屏列表：只服务「本机被控」这一种语义（会话中改对方的那条不给屏列表，
  // 对端的屏与这台机器无关）。
  useEffect(() => {
    void rcListMonitors()
      .then(setMonitors)
      .catch(() => setMonitors([]));
    void rcEncodeCaps()
      .then(setCaps)
      .catch(() => setCaps(null));
  }, []);

  // 档位表与文案的唯一真源在 lib/rcScope，这里只负责取显示器列表
  const scopes = scopeOptions(monitors);
  const qualities = visibleQualities({
    h264Gpu: caps?.h264_gpu,
    refreshHz: caps?.refresh_hz,
    // Q3/Q4：uhd60 档的判定还要本机 HEVC 硬编（caps 里取了 hevc_hw 却一直没喂进来）
    hevcHw: caps?.hevc_hw,
  });

  const pickQuality = (k: RcQuality) => {
    if (k === quality) return;
    const was = quality as RcQuality;
    onPickQuality?.(k);
    void rc.setQuality(k).then((ok) => {
      setFb(ok ? { kind: "ok", text: "画质已保存" } : { kind: "bad", text: "保存失败，已恢复" });
      if (!ok) onPickQuality?.(was);
    });
  };

  const pickScope = (k: RcCaptureScope) => {
    if (k === captureScope) return;
    const was = captureScope as RcCaptureScope;
    onPickScope?.(k);
    void rc.setCaptureScope(k).then((ok) => {
      setFb(ok ? { kind: "ok", text: "范围已保存" } : { kind: "bad", text: "保存失败，已恢复" });
      if (!ok) onPickScope?.(was);
    });
  };

  const fbCls =
    fb?.kind === "ok" ? styles.fbOk : fb?.kind === "bad" ? styles.fbBad : styles.fbInfo;

  return (
    // v4 对稿（A2 窗「画质设置」卡）：不再是一条 inline 混排的横条——
    // 画质 6 档 + 画面范围 + 说明文案挤在一个 flex-wrap 里会折成三行、
    // 说明文字跟在最后一个 pill 后面像个假按钮。改成块状：两组各占一行
    // （组标签 + pills），说明文字独立成行贴底。
    <div className={styles.qBar}>
      <div className={styles.qRow} role="group" aria-label="画质档位">
        <span className={styles.qLabel}>画质</span>
        {qualities.map(({ key, label, tip }) => (
          <button
            key={key}
            type="button"
            title={tip}
            disabled={disabled || rc.busy}
            className={quality === key ? styles.pillOn : styles.pill}
            onClick={() => pickQuality(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className={styles.qRow} role="group" aria-label="画面范围">
        <span className={styles.qLabel}>画面</span>
        {scopes.map(({ key, label, tip }) => (
          <button
            key={key}
            type="button"
            title={tip}
            disabled={disabled || rc.busy}
            className={captureScope === key ? styles.pillOn : styles.pill}
            onClick={() => pickScope(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className={styles.qNote}>{localNote}</div>
      {fb && <span className={`${styles.fb} ${fbCls}`}>{fb.text}</span>}
    </div>
  );
}
