/**
 * RecSelectOverlay — 录屏选区覆盖层（全屏透明窗，rec.html 入口）。
 *
 * 状态机（§18 轻预览优先，两级取消）：
 *   preview（悬停高亮窗口，单击=录窗口 / 桌面空白=录整屏 / 拖拽=自定义）
 *   → confirm（确认条可改档位与音源；Esc 回预览）→ countdown（3s，Esc 回确认条）
 *   → recording（整窗鼠标穿透；出口只有停止条）→ 完成/失败事件 → 关窗。
 *
 * 选屏交互 = 方案 A（2026-10-05 设计稿）：悬停哪个窗口哪个亮，单击就录它；
 * 窗口矩形是采纳瞬间的静态区域，录制中窗口移动不跟随（尺寸标签已写明）。
 * 鼠标状态机在 hooks/useRecSelectMouse，纯展示部件在 RecOverlayParts，矩形工具在 snap。
 */
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  recCloseWindows,
  recGetScreen,
  recReady,
  recStart,
  recTakeRerecord,
  type RecQualityKey,
  type RecScreenInfo,
} from "@/lib/api/rec";
import { recQualityOf, type RecQualityItem } from "@/lib/recQuality";
import type { Rect } from "./snap";
import { ConfirmBar, CountdownOverlay, FatalCard, PreviewHintBar, Shades } from "./RecOverlayParts";
import { useRecSelectMouse, type Phase } from "@/hooks/useRecSelectMouse";

export function RecSelectOverlay({ config }: { config: Record<string, unknown> | null }) {
  const [phase, setPhase] = useState<Phase>("preview");
  const [screen, setScreen] = useState<RecScreenInfo | null>(null);
  const [countdown, setCountdown] = useState(3);
  const [failMsg, setFailMsg] = useState<string | null>(null);
  const [quality, setQuality] = useState<RecQualityItem>(() => recQualityOf(null));
  const [sysAudio, setSysAudio] = useState(true);
  const [micAudio, setMicAudio] = useState(false);

  // 鼠标状态机（预览悬停 / 拖拽吸附 / 单击采纳 / 两级取消）与可吸附窗口列表
  const mouse = useRecSelectMouse(phase, setPhase, screen);
  const { setRect, backToPreview } = mouse;

  // 挂载：读几何 + 配置默认值 + 撤销存活探针。
  // URL 带 mode=rerecord（重录上次区域）：取回上次计划后跳过预览/确认直入倒计时。
  useEffect(() => {
    recGetScreen().then((s) => {
      setScreen(s);
      if (new URLSearchParams(window.location.search).get("mode") === "rerecord") {
        void recTakeRerecord().then((plan) => {
          if (!plan) return;
          const dpr = window.devicePixelRatio || 1;
          setQuality(recQualityOf(plan.quality));
          setSysAudio(plan.sysAudio);
          setMicAudio(plan.micAudio);
          setRect({
            x: (plan.x - s.originX) / dpr,
            y: (plan.y - s.originY) / dpr,
            w: plan.w / dpr,
            h: plan.h / dpr,
          });
          setCountdown(3);
          setPhase("countdown");
        });
      }
    }).catch((e) => {
      setFailMsg(String(e instanceof Error ? e.message : e));
      setPhase("failed");
    });
    setQuality(recQualityOf(config?.rec_quality as string | undefined));
    setSysAudio(config?.rec_sys_audio !== false);
    setMicAudio(config?.rec_mic_audio === true);
    void recReady();
    // setRect 来自 useRecSelectMouse（useState setter，恒定）——eslint 认不出自定义
    // hook 返回值的稳定性，须显式列出
  }, [config, setRect]);

  /** 当前生效的选区（CSS 坐标）。preview / 整屏采纳 = 整屏；screen 是物理像素，÷dpr 转 CSS。 */
  const dpr = window.devicePixelRatio || 1;
  const activeRect: Rect | null =
    phase === "preview" || !mouse.rect
      ? screen
        ? { x: 0, y: 0, w: screen.width / dpr, h: screen.height / dpr }
        : null
      : mouse.rect;

  // Esc 两级取消（§18）：预览/失败卡 = 退出选屏；拖拽/确认 = 回预览；倒计时 = 回确认条。
  // recording 态没有 Esc 出口（设计稿：出口只有停止条）。
  // 🔴 方案 A 重写时这段曾被整段弄丢——界面上所有「Esc ××」文案变成空头支票，
  // 倒计时态更是完全无法取消（该态忽略鼠标事件）。守卫见 recOverlayEscapeGuard.test.ts。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (phase === "preview" || phase === "failed") {
        void recCloseWindows();
      } else if (phase === "dragging" || phase === "confirm") {
        backToPreview();
      } else if (phase === "countdown") {
        setPhase("confirm");
      }
    };
    // 冒泡期挂（同旧实现）：捕获期会触发 dialogEscapeLayering 守卫的手挂登记要求
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, backToPreview]);

  // 倒计时归零 → 真正开录
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
    return <FatalCard msg={failMsg} onClose={() => void recCloseWindows()} />;
  }
  if (!screen || !activeRect) return null;

  const recording = phase === "recording";
  const { hoverRect, snapRect, rectFromWindow } = mouse;
  const hovering = phase === "preview" && hoverRect !== null;

  return (
    <div
      onMouseDown={mouse.onMouseDown}
      onMouseMove={mouse.onMouseMove}
      onMouseUp={mouse.onMouseUp}
      style={{ width: "100%", height: "100%", position: "relative" }}
    >
      {/* 暗遮罩：预览/拖拽/确认态才有；录制中零遮挡 */}
      {!recording && <Shades rect={activeRect} screenCss={{ w: screen.width / dpr, h: screen.height / dpr }} />}
      {/* 全屏预览态的四边暗带（同截图 .edge-band 的全屏辨识） */}
      {phase === "preview" && (
        <>
          <div className="rec-edge-band" style={{ left: 0, top: 0, right: 0, height: 6 }} />
          <div className="rec-edge-band" style={{ left: 0, bottom: 0, right: 0, height: 6 }} />
          <div className="rec-edge-band" style={{ left: 0, top: 0, bottom: 0, width: 6 }} />
          <div className="rec-edge-band" style={{ right: 0, top: 0, bottom: 0, width: 6 }} />
        </>
      )}

      {/* 选区框：悬停高亮时整屏框让位（蓝窗亮 = 当前目标，两个框并存会打架） */}
      {!hovering && (
        <div
          className={`rec-rect${phase === "preview" ? " full" : ""}${recording ? " recording" : ""}`}
          style={{
            left: activeRect.x - 1.5,
            top: activeRect.y - 1.5,
            width: activeRect.w,
            height: activeRect.h,
          }}
        />
      )}
      {hovering && (
        <div
          className="rec-snap"
          style={{
            left: hoverRect.x - 1.5,
            top: hoverRect.y - 1.5,
            width: hoverRect.w,
            height: hoverRect.h,
          }}
        />
      )}

      {/* 拖拽吸附高亮：与悬停同一枚样式，场景不重叠 */}
      {phase === "dragging" && snapRect && (
        <div
          className="rec-snap"
          style={{
            left: snapRect.x - 1.5,
            top: snapRect.y - 1.5,
            width: snapRect.w,
            height: snapRect.h,
          }}
        />
      )}

      {/* 尺寸标签（非预览态；吸附/窗口来源各有提示，L5 不靠猜） */}
      {(phase === "dragging" || phase === "confirm") && (
        <div
          className="rec-glass"
          style={{ left: activeRect.x, top: Math.max(8, activeRect.y - 40) }}
        >
          <span>
            {Math.round(activeRect.w * dpr)}×{Math.round(activeRect.h * dpr)}
          </span>
          <span className="muted">
            {phase === "dragging" && mouse.snapRect
              ? "松手录制该窗口 · 拖离自由框选"
              : phase === "confirm" && rectFromWindow
                ? "按窗口位置录制，窗口移动不跟随 · Esc 重选"
                : "拖边缘可调整（重画）· Esc 重选"}
          </span>
        </div>
      )}

      {/* 预览态提示条（底部居中；方案 A 文案 + 整屏兜底按钮） */}
      {phase === "preview" && (
        <PreviewHintBar
          screenCssH={screen.height / dpr}
          screenW={Math.round(screen.width)}
          screenH={Math.round(screen.height)}
          onFullscreen={mouse.adoptFullscreen}
        />
      )}

      {/* 确认条（选区确立后） */}
      {phase === "confirm" && (
        <ConfirmBar
          rect={activeRect}
          screenCssW={screen.width / dpr}
          screenCssH={screen.height / dpr}
          quality={quality}
          onQuality={setQuality}
          sysAudio={sysAudio}
          micAudio={micAudio}
          onSys={() => setSysAudio((v) => !v)}
          onMic={() => setMicAudio((v) => !v)}
          onRedraw={mouse.backToPreview}
          onStart={() => {
            setCountdown(3);
            setPhase("countdown");
          }}
        />
      )}

      {/* 倒计时（只盖选区） */}
      {phase === "countdown" && <CountdownOverlay rect={activeRect} count={countdown} />}
    </div>
  );
}
