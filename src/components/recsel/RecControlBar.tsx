import { useEffect, useRef, useState } from "react";
import { Ellipsis, GripVertical, Pause, Play, Square, TriangleAlert, X } from "lucide-react";
import { recResizeControl } from "@/lib/api/rec";
import { formatBytes, formatRecordingTime } from "@/lib/utils";
import { recQualityOf } from "@/lib/recQuality";
import { useRecControlState } from "@/hooks/useRecControlState";
import styles from "./RecControlBar.module.css";

/**
 * 音源态只保留「点的实心 / 空心 / 警示」三态（§5.1：文字不再写「开 / 关」）。
 * 不可用是必须留的一态——它和「关着」在动作后果上不同（一个点一下就开，一个点了也没声）。
 */
function audioDot(requested: boolean | undefined, active: boolean | null | undefined) {
  if (!requested) return "";
  if (active === false) return styles.warn;
  return active === true ? styles.on : "";
}

/**
 * 录制中控制条（rec-control.html 的根组件）。
 *
 * 2026-10-16 苹果风重做（方案 §5 / 设计稿 §3）：
 * ① **尺寸不再由 TS 公式算**：旧代码里 260/288/80/104 × 28/36/192/280 六个数字散在
 *    `useState` 附近，每加一个元素都要重算；现在量 `.surface` 的自然尺寸后上报，
 *    窗口恰好等于看得见的那块（不留透明大窗拦桌面操作）；
 * ② 三态（正常 / 更多 / 收起）是同一条的形变，面板入场走 `--ease-spring`；
 * ③「更多」从三行灰字 <p> + 四个按钮改成「标签 + 值」信息卡，动作区独立；
 * ④ 一屏一个实色：只有「停止」是实底，丢弃改成描边红（`arm`）。
 */
export function RecControlBar({ qualityLabel, onStop, finalizing }: {
  qualityLabel: string;
  onStop: (discard: boolean) => void | Promise<void>;
  finalizing: boolean;
}) {
  const control = useRecControlState(finalizing, onStop);
  const { setError } = control;
  const saving = finalizing || control.status?.finalizing;
  const [collapsed, setCollapsed] = useState(false);
  const [panel, setPanel] = useState<"more" | "notice" | null>(null);
  const [armDiscard, setArmDiscard] = useState(false);
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const resizeQueue = useRef(Promise.resolve());
  const lastSize = useRef({ w: 0, h: 0 });
  const warning = (control.status?.warnings ?? []).join("；");
  const problem = control.error || warning;
  const elapsed = control.status?.elapsedMs ?? 0;
  const preparing = !control.status || control.status.starting;
  const clock = preparing ? "--:--" : formatRecordingTime(elapsed);
  const stateLabel = !control.status ? "正在确认" : control.status.starting ? "正在准备" : control.status.paused ? "已暂停" : "录制中";
  const stateDot = preparing ? styles.unknown : control.status?.paused ? styles.paused : styles.dot;
  const qualityText = control.status?.quality ? recQualityOf(control.status.quality).label : qualityLabel || "—";

  // 尺寸的唯一来源：量内容的自然尺寸（内容变了就自动跟随，不用再去改公式）
  useEffect(() => {
    if (!surface) return;
    let alive = true;
    // 换过渲染分支后窗口尺寸可能已被改走，重置缓存保证这一轮一定上报一次
    lastSize.current = { w: 0, h: 0 };
    const report = () => {
      const w = Math.ceil(surface.offsetWidth);
      const h = Math.ceil(surface.offsetHeight);
      if (!w || !h || (w === lastSize.current.w && h === lastSize.current.h)) return;
      lastSize.current = { w, h };
      // A late expansion must not undo a newer collapse.
      resizeQueue.current = resizeQueue.current.catch(() => {}).then(() => recResizeControl(w, h))
        .catch(() => { if (alive) setError("控制条大小调整失败，可重试操作或停止录制。"); });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(surface);
    return () => { alive = false; observer.disconnect(); };
  }, [surface, setError]);
  useEffect(() => {
    if (problem) { setCollapsed(false); setPanel("notice"); }
    else setPanel(previous => previous === "notice" ? null : previous);
  }, [problem]);
  useEffect(() => {
    if (!armDiscard) return;
    const timer = setTimeout(() => setArmDiscard(false), 3000);
    return () => clearTimeout(timer);
  }, [armDiscard]);
  const stop = async (discard = false) => {
    if (!await control.stop(discard)) { setCollapsed(false); setPanel("notice"); }
  };
  const togglePause = async () => {
    if (!await control.togglePause()) setPanel("notice");
  };

  if (saving) return (
    <div className={styles.root}>
      <div className={styles.surface} ref={setSurface}>
        <div className={styles.row} role="status">正在保存录像…</div>
      </div>
    </div>
  );
  if (collapsed) return (
    <div className={styles.root}>
      <div className={styles.surface} ref={setSurface}>
        <button type="button" className={styles.tiny} onClick={() => setCollapsed(false)}
          aria-label={`展开录屏控制条，${stateLabel}${problem ? `，异常：${problem}` : ""}`}>
          <i className={stateDot} />
          <span className={styles.clock}>{clock}</span>
          {preparing && <span className={styles.state}>{stateLabel}</span>}
          {problem && <span className={styles.tinyProblem}><TriangleAlert size={12} aria-hidden="true" />异常</span>}
        </button>
      </div>
    </div>
  );
  return (
    <div className={styles.root} onKeyDown={event => { if (event.key === "Escape") { setPanel(null); setArmDiscard(false); } }}>
      <div className={styles.surface} ref={setSurface}>
        {panel && <section className={styles.panel} aria-label={panel === "more" ? "录制详情" : "录制异常"}>
          {problem && <div className={styles.error} role="alert">
            <TriangleAlert size={13} aria-hidden="true" />
            <span>{problem}</span>
            <button type="button" onClick={() => setPanel(null)} title="收起提示" aria-label="收起提示">
              <X size={13} aria-hidden="true" />
            </button>
          </div>}
          {panel === "more" && <>
            <div className={styles.rows}>
              <div className={styles.mrow}><span className={styles.k}>画质</span><span className={styles.v}>{qualityText}</span></div>
              <div className={styles.mrow}>
                <span className={styles.k}>声音</span>
                {/* 文字只留名字，状态交给点（§5.1） */}
                <span className={`${styles.v} ${styles.sndv}`}>
                  <i className={audioDot(control.status?.sysAudio, control.status?.sysAudioActive)} />电脑声音
                  <i className={audioDot(control.status?.micAudio, control.status?.micAudioActive)} />麦克风
                </span>
              </div>
              <div className={styles.mrow}><span className={styles.k}>已写入</span><span className={styles.v}>{formatBytes(control.status?.bytes ?? 0)}</span></div>
            </div>
            <div className={styles.dash} />
            <div className={styles.acts}>
              <button type="button" onClick={() => { setPanel(null); setCollapsed(true); }}>收起</button>
              <button type="button" className={armDiscard ? styles.arm : undefined}
                title={armDiscard ? "再点一次即丢弃，且无法恢复" : "丢弃这段录像"}
                onClick={() => armDiscard ? void stop(true) : setArmDiscard(true)}>
                {armDiscard ? "确认丢弃" : "丢弃录像"}
              </button>
            </div>
          </>}
          {panel === "notice" && <div className={styles.acts}>
            {(control.failedAction === "pause" || control.failedAction === "resume") &&
              <button type="button" disabled={control.busy || preparing} onClick={() => void togglePause()}>
                {control.status?.paused ? "重试继续" : "重试暂停"}
              </button>}
            <button type="button" onClick={() => void stop()}>重试停止</button>
          </div>}
        </section>}
        <div className={styles.row}>
          <span className={styles.grip} data-tauri-drag-region title="拖动控制条"><GripVertical size={12} aria-hidden="true" /></span>
          <span className={styles.timer} data-tauri-drag-region aria-label={stateLabel}>
            <i className={stateDot} />
            {/* key 变化 = 换帧入场；clock 不变时不会有多余动画 */}
            <span key={clock} className={`${styles.clock} ${styles.clockTick}`}>{clock}</span>
            {preparing && <span className={styles.state}>{stateLabel}</span>}
          </span>
          <button type="button" onClick={() => void togglePause()} disabled={control.busy || preparing} title={control.status?.paused ? "继续录制" : "暂停录制"}>
            {control.status?.paused ? <Play size={12} aria-hidden="true" /> : <Pause size={12} aria-hidden="true" />}{control.status?.paused ? "继续" : "暂停"}
          </button>
          <button type="button" className={styles.stop} onClick={() => void stop()} aria-label="停止并保存" title="停止并保存">
            <Square size={12} aria-hidden="true" />停止
          </button>
          <button type="button" className={problem ? styles.problem : styles.more}
            aria-expanded={panel !== null} aria-label={problem ? "录制异常详情" : "更多"}
            title={problem ? "录制异常详情" : "更多"}
            onClick={() => { setPanel(panel ? null : "more"); setArmDiscard(false); }}>
            {problem ? <TriangleAlert size={13} aria-hidden="true" /> : <Ellipsis size={13} aria-hidden="true" />}
          </button>
        </div>
      </div>
    </div>
  );
}
