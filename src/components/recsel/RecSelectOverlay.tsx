/**
 * RecSelectOverlay — 录屏选区覆盖层（全屏透明窗，rec.html 入口）。
 *
 * 状态机（§18 轻预览优先，两级取消）：
 *   preview（整屏预览即默认，单击采纳 / 拖拽自定义）
 *   → confirm（选区确立，确认条可改档位与音源；Esc 回预览）
 *   → countdown（3s，Esc 回确认条）
 *   → recording（整窗鼠标穿透，只剩红框脉动；出口只有停止条）
 *   → 完成/失败事件 → 关窗（失败先恢复交互显示错误卡，规则 15.3 不静默）。
 *
 * 坐标：窗口盖整个虚拟屏，CSS 坐标 × dpr + 虚拟屏原点 = 物理坐标（与截图同口径）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  recCloseWindows,
  recGetScreen,
  recReady,
  recStart,
  type RecQualityKey,
  type RecScreenInfo,
} from "@/lib/api/rec";
import { REC_QUALITIES, recQualityOf, type RecQualityItem } from "@/lib/recQuality";

const REC_QUALITY_KEYS = REC_QUALITIES;

type Phase = "preview" | "dragging" | "confirm" | "countdown" | "recording" | "failed";

/** 预览态提示文案（写清两条路与两级取消）。 */
const PREVIEW_HINT = "单击 录整屏 · 拖拽 框选区域";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function RecSelectOverlay({ config }: { config: Record<string, unknown> | null }) {
  const [phase, setPhase] = useState<Phase>("preview");
  const [screen, setScreen] = useState<RecScreenInfo | null>(null);
  const [rect, setRect] = useState<Rect | null>(null); // CSS 坐标（窗口内）
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [countdown, setCountdown] = useState(3);
  const [failMsg, setFailMsg] = useState<string | null>(null);
  const [quality, setQuality] = useState<RecQualityItem>(() => recQualityOf(null));
  const [sysAudio, setSysAudio] = useState(true);
  const [micAudio, setMicAudio] = useState(false);
  const dragMoved = useRef(false);

  // 挂载：读几何 + 配置默认值 + 撤销存活探针
  useEffect(() => {
    recGetScreen().then(setScreen).catch((e) => {
      setFailMsg(String(e instanceof Error ? e.message : e));
      setPhase("failed");
    });
    setQuality(recQualityOf(config?.rec_quality as string | undefined));
    setSysAudio(config?.rec_sys_audio !== false);
    setMicAudio(config?.rec_mic_audio === true);
    void recReady();
  }, [config]);

  /** 当前生效的选区（CSS 坐标）。preview / 单击采纳 = 整屏；screen 是物理像素，÷dpr 转 CSS。 */
  const dpr = window.devicePixelRatio || 1;
  const activeRect: Rect | null =
    phase === "preview" || !rect
      ? screen
        ? { x: 0, y: 0, w: screen.width / dpr, h: screen.height / dpr }
        : null
      : rect;

  const toCss = useCallback(
    (e: { clientX: number; clientY: number }) => ({ x: e.clientX, y: e.clientY }),
    [],
  );

  const onMouseDown = (e: React.MouseEvent) => {
    if (phase !== "preview" && phase !== "confirm") return;
    if (phase === "confirm") {
      // 点选区外 = 重画（轻预览范式：一键可推翻）；点在确认条/选区内不触发
      const t = e.target as HTMLElement;
      if (t.closest(".rec-glass") || (rect && inRect(toCss(e), rect))) return;
    }
    dragMoved.current = false;
    setDragStart(toCss(e));
    setRect(null);
    setPhase("dragging");
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (phase !== "dragging" || !dragStart) return;
    const p = toCss(e);
    if (Math.abs(p.x - dragStart.x) + Math.abs(p.y - dragStart.y) > 3) {
      dragMoved.current = true;
    }
    setRect({
      x: Math.min(dragStart.x, p.x),
      y: Math.min(dragStart.y, p.y),
      w: Math.abs(p.x - dragStart.x),
      h: Math.abs(p.y - dragStart.y),
    });
  };

  const onMouseUp = () => {
    if (phase !== "dragging") return;
    setDragStart(null);
    if (!dragMoved.current || !rect || rect.w < 16 || rect.h < 16) {
      // 单击（或太小的框）= 采纳整屏（§18 P2：高频动作一步到位）
      setRect(null);
      setPhase("confirm");
      return;
    }
    setRect(normalizeEven(rect));
    setPhase("confirm");
  };

  /** Esc 两级取消：拖拽/确认 → 预览；倒计时 → 确认；失败卡 → 关窗。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (phase === "dragging" || phase === "confirm") {
        setRect(null);
        setPhase("preview");
      } else if (phase === "countdown") {
        setPhase("confirm");
      } else if (phase === "failed") {
        void recCloseWindows();
      }
      // recording 态没有 Esc 出口（设计稿：出口只有停止条）
    };
    // 冒泡期挂（同截图覆盖层）：本覆盖层就是顶层窗口的全部内容，没有
    // 「别的捕获期监听要协调」；捕获期会让 dialogEscapeLayering 守卫多一份要登记的副本。
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase]);

  // 倒计时
  useEffect(() => {
    if (phase !== "countdown") return;
    if (countdown <= 0) {
      void beginRecording();
      return;
    }
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, countdown]);

  const beginRecording = async () => {
    if (!screen || !activeRect) return;
    try {
      // CSS → 物理：后端吃虚拟屏物理像素（宽高对齐偶数，编码器 4:2:0 要求）
      await recStart({
        x: screen.originX + Math.round(activeRect.x * dpr),
        y: screen.originY + Math.round(activeRect.y * dpr),
        w: Math.max(16, Math.round(activeRect.w * dpr) & ~1),
        h: Math.max(16, Math.round(activeRect.h * dpr) & ~1),
        quality: quality.key as RecQualityKey,
        sysAudio,
        micAudio,
      });
      // 整窗鼠标穿透：录制中画面零遮挡，出口只剩控制条（独立窗）
      await getCurrentWindow().setIgnoreCursorEvents(true);
      setPhase("recording");
    } catch (err) {
      setFailMsg(err instanceof Error ? err.message : String(err));
      setPhase("failed");
    }
  };

  // 会话收尾事件 → 关窗；失败 → 恢复交互 + 错误卡（穿透必须先撤）
  useEffect(() => {
    const close = () => void recCloseWindows();
    const un1 = listen("rec-done", close);
    const un2 = listen("rec-discarded", close);
    const un3 = listen("rec-failed", (ev) => {
      void getCurrentWindow().setIgnoreCursorEvents(false);
      setFailMsg((ev.payload as { message?: string })?.message ?? "录制失败");
      setPhase("failed");
    });
    return () => {
      void un1.then((f) => f());
      void un2.then((f) => f());
      void un3.then((f) => f());
    };
  }, []);

  if (phase === "failed") {
    return (
      <div className="rec-fatal">
        <div className="card">
          {failMsg ?? "录制失败"}
          <div>
            <button type="button" onClick={() => void recCloseWindows()}>
              关闭（Esc）
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (!screen || !activeRect) return null;

  const recording = phase === "recording";

  return (
    <div
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      style={{ width: "100%", height: "100%", position: "relative" }}
    >
      {/* 暗遮罩：预览/拖拽/确认态才有；录制中零遮挡 */}
      {!recording && <Shades rect={activeRect} screenCss={{ w: screen.width, h: screen.height }} />}
      {/* 全屏预览态的四边暗带（同截图 .edge-band 的全屏辨识） */}
      {phase === "preview" && (
        <>
          <div className="rec-edge-band" style={{ left: 0, top: 0, right: 0, height: 6 }} />
          <div className="rec-edge-band" style={{ left: 0, bottom: 0, right: 0, height: 6 }} />
          <div className="rec-edge-band" style={{ left: 0, top: 0, bottom: 0, width: 6 }} />
          <div className="rec-edge-band" style={{ right: 0, top: 0, bottom: 0, width: 6 }} />
        </>
      )}

      {/* 选区框 */}
      <div
        className={`rec-rect${phase === "preview" ? " full" : ""}${recording ? " recording" : ""}`}
        style={{
          left: activeRect.x - 1.5,
          top: activeRect.y - 1.5,
          width: activeRect.w,
          height: activeRect.h,
        }}
      />

      {/* 尺寸标签（非预览态） */}
      {(phase === "dragging" || phase === "confirm") && (
        <div
          className="rec-glass"
          style={{ left: activeRect.x, top: Math.max(8, activeRect.y - 40) }}
        >
          <span>
            {Math.round(activeRect.w * dpr)}×{Math.round(activeRect.h * dpr)}
          </span>
          <span className="muted">拖边缘可调整（重画）· Esc 回整屏</span>
        </div>
      )}

      {/* 预览态提示条（底部居中） */}
      {phase === "preview" && (
        <div className="rec-glass" style={{ left: "50%", transform: "translateX(-50%)", bottom: screen.height / dpr * 0.08 }}>
          <span>
            {Math.round(screen.width)}×{Math.round(screen.height)}
          </span>
          <span className="muted">|</span>
          <span>
            {PREVIEW_HINT} · <kbd>Esc</kbd> 退出
          </span>
        </div>
      )}

      {/* 确认条（选区确立后） */}
      {phase === "confirm" && (
        <ConfirmBar
          rect={activeRect}
          screenCssH={screen.height / dpr}
          quality={quality}
          onQuality={setQuality}
          sysAudio={sysAudio}
          micAudio={micAudio}
          onSys={() => setSysAudio((v) => !v)}
          onMic={() => setMicAudio((v) => !v)}
          onRedraw={() => {
            setRect(null);
            setPhase("preview");
          }}
          onStart={() => {
            setCountdown(3);
            setPhase("countdown");
          }}
        />
      )}

      {/* 倒计时（只盖选区） */}
      {phase === "countdown" && (
        <div
          className="rec-countdown"
          style={{
            left: activeRect.x,
            top: activeRect.y,
            width: activeRect.w,
            height: activeRect.h,
          }}
        >
          <span className="num">{Math.max(1, countdown)}</span>
          <span className="esc">
            <kbd>Esc</kbd> 取消，回到选区
          </span>
        </div>
      )}
    </div>
  );
}

/** 四块暗遮罩（框外区域；坐标与截图同法）。 */
function Shades({ rect, screenCss }: { rect: Rect; screenCss: { w: number; h: number } }) {
  const top = { left: 0, top: 0, width: screenCss.w, height: Math.max(0, rect.y) };
  const bottom = {
    left: 0,
    top: rect.y + rect.h,
    width: screenCss.w,
    height: Math.max(0, screenCss.h - rect.y - rect.h),
  };
  const left = { left: 0, top: rect.y, width: Math.max(0, rect.x), height: rect.h };
  const right = {
    left: rect.x + rect.w,
    top: rect.y,
    width: Math.max(0, screenCss.w - rect.x - rect.w),
    height: rect.h,
  };
  return (
    <>
      {[top, bottom, left, right].map((s, i) => (
        <div
          key={i}
          className="rec-shade"
          style={{ left: s.left, top: s.top, width: s.width, height: s.height }}
        />
      ))}
    </>
  );
}

function ConfirmBar(props: {
  rect: Rect;
  screenCssH: number;
  quality: RecQualityItem;
  onQuality: (q: RecQualityItem) => void;
  sysAudio: boolean;
  micAudio: boolean;
  onSys: () => void;
  onMic: () => void;
  onRedraw: () => void;
  onStart: () => void;
}) {
  const { rect, screenCssH, quality, onQuality, sysAudio, micAudio, onSys, onMic, onRedraw, onStart } = props;
  const barW = 520;
  const x = Math.max(8, rect.x + rect.w / 2 - barW / 2);
  const below = rect.y + rect.h + 14;
  const top = below + 56 > screenCssH ? Math.max(8, rect.y - 70) : below;
  return (
    <div className="rec-glass" style={{ left: x, top, gap: 8 }}>
      <button type="button" className="rec-btn-start" onClick={onStart}>
        <span className="dot" />
        开始录制
      </button>
      <button type="button" className="rec-btn-ghost" onClick={onRedraw}>
        重画
      </button>
      <span className="rec-seg" role="group" aria-label="画质档位">
        {REC_QUALITY_KEYS.map((q) => (
          <button
            key={q.key}
            type="button"
            className={quality.key === q.key ? "on" : ""}
            onClick={() => onQuality(q)}
            title={q.desc}
          >
            {q.label}
          </button>
        ))}
      </span>
      <button
        type="button"
        className={`rec-snd${sysAudio ? " on" : " off"}`}
        onClick={onSys}
        title="录进电脑正在播放的声音"
        aria-pressed={sysAudio}
      >
        🔊 系统声音
      </button>
      <button
        type="button"
        className={`rec-snd${micAudio ? " on" : " off"}`}
        onClick={onMic}
        title="录进解说人声"
        aria-pressed={micAudio}
      >
        🎙 麦克风
      </button>
    </div>
  );
}

function inRect(p: { x: number; y: number }, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/** 宽高对齐偶数（编码器要求）；不足 16px 的维度由调用方拒绝。 */
function normalizeEven(r: Rect): Rect {
  return { x: r.x, y: r.y, w: Math.max(16, r.w & ~1), h: Math.max(16, r.h & ~1) };
}
