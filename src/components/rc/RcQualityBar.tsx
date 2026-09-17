/**
 * RcQualityBar — 画质档 + 画面范围 + 即时反馈（禁止静默失败）。
 * - mode=local：写本机配置
 * - mode=remote：会话中发给对端；失败必须回滚选中 + 文案
 */
import { useEffect, useState } from "react";
import { rcSendInput, rcListMonitors, type RcMonitorInfo } from "@/lib/api/rc";
import type { RcQuality, RcCaptureScope } from "@/lib/api/rc";
import type { UseRc } from "@/hooks/useRc";
import styles from "./RemoteComputer.module.css";

const QUALITIES: Array<[RcQuality, string, string]> = [
  ["smooth", "流畅", "约 6fps · 宽 960 · 弱网"],
  ["balanced", "均衡", "约 5fps · 宽 1280 · 默认"],
  ["sharp", "清晰", "约 8fps · 宽 1920 · 局域网"],
  ["ultra", "超清", "约 5fps · 宽 2560 · JPEG 路径"],
  ["uhd", "原生", "主屏硬编原生分辨率 · 需 GPU · 无硬编回落超清"],
];

type Fb = { kind: "ok" | "warn" | "bad" | "info"; text: string } | null;

export function RcQualityBar({
  rc,
  quality,
  captureScope,
  mode = "local",
  disabled,
  onPickQuality,
  onPickScope,
}: {
  rc: UseRc;
  quality: string;
  captureScope: string;
  mode?: "local" | "remote";
  disabled?: boolean;
  onPickQuality?: (q: RcQuality) => void;
  onPickScope?: (s: RcCaptureScope) => void;
}) {
  const [fb, setFb] = useState<Fb>(null);
  const [monitors, setMonitors] = useState<RcMonitorInfo[]>([]);

  // 会话中（remote）显示器列表必须来自对端，本机列表会误导；只看本地配置时才列本机屏
  useEffect(() => {
    if (mode === "remote") {
      setMonitors([]);
      return;
    }
    void rcListMonitors()
      .then(setMonitors)
      .catch(() => setMonitors([]));
  }, [mode]);

  const scopes: Array<[RcCaptureScope, string, string]> = [
    ["virtual", "整屏", "整个虚拟屏（含副屏拼接）"],
    ["primary", "仅主屏", "只截主显示器"],
    ...monitors.map(
      (m) =>
        [
          `monitor:${m.index}` as RcCaptureScope,
          m.primary ? `屏${m.index + 1}·主` : `屏${m.index + 1}`,
          `${m.w}×${m.h} @ (${m.x},${m.y})`,
        ] as [RcCaptureScope, string, string],
    ),
  ];

  const remoteSend = async (
    ev: Parameters<typeof rcSendInput>[0],
    restore: () => void,
    okText: string,
  ) => {
    setFb({ kind: "info", text: "应用中…" });
    try {
      await rcSendInput(ev);
      setFb({ kind: "ok", text: okText });
    } catch (e) {
      restore();
      setFb({ kind: "bad", text: `改档失败：${e}` });
    }
  };

  const pickQuality = (k: RcQuality) => {
    if (k === quality) return;
    const was = quality as RcQuality;
    onPickQuality?.(k);
    if (mode === "remote") {
      void remoteSend(
        { kind: "set_quality", quality: k },
        () => onPickQuality?.(was),
        "画质已同步到对方",
      );
    } else {
      void rc.setQuality(k).then((ok) => {
        setFb(
          ok
            ? { kind: "ok", text: "画质已保存" }
            : { kind: "bad", text: "保存失败，已恢复" },
        );
        if (!ok) onPickQuality?.(was);
      });
    }
  };

  const pickScope = (k: RcCaptureScope) => {
    if (k === captureScope) return;
    const was = captureScope as RcCaptureScope;
    onPickScope?.(k);
    if (mode === "remote") {
      void remoteSend(
        { kind: "set_capture_scope", scope: k },
        () => onPickScope?.(was),
        "画面范围已同步到对方",
      );
    } else {
      void rc.setCaptureScope(k).then((ok) => {
        setFb(
          ok
            ? { kind: "ok", text: "范围已保存" }
            : { kind: "bad", text: "保存失败，已恢复" },
        );
        if (!ok) onPickScope?.(was);
      });
    }
  };

  const fbCls =
    fb?.kind === "ok"
      ? styles.fbOk
      : fb?.kind === "bad"
        ? styles.fbBad
        : fb?.kind === "warn"
          ? styles.fbWarn
          : styles.fbInfo;

  return (
    <div className={styles.qBar}>
      <span className={styles.qLabel}>画质</span>
      {QUALITIES.map(([k, label, tip]) => (
        <button
          key={k}
          type="button"
          title={tip}
          disabled={disabled || rc.busy}
          className={quality === k ? styles.pillOn : styles.pill}
          onClick={() => pickQuality(k)}
        >
          {label}
        </button>
      ))}
      <span className={styles.qSp} />
      <span className={styles.qLabel}>画面</span>
      {scopes.map(([k, label, tip]) => (
        <button
          key={k}
          type="button"
          title={tip}
          disabled={disabled || rc.busy}
          className={captureScope === k ? styles.pillOn : styles.pill}
          onClick={() => pickScope(k)}
        >
          {label}
        </button>
      ))}
      {mode === "remote" && (
        <span className={`${styles.meta} ${styles.qMeta}`}>立即作用于对方</span>
      )}
      {fb && <span className={`${styles.fb} ${fbCls}`}>{fb.text}</span>}
    </div>
  );
}
