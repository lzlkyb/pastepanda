/**
 * RecSelectOverlay — 录屏选区覆盖层（全屏透明窗，rec.html 入口）。
 *
 * 状态机（§18 轻预览优先，两级取消）：
 *   preview（悬停高亮窗口，单击=录窗口 / 桌面空白=录整屏 / 拖拽=自定义）
 *   → confirm（确认条可改档位与音源；Esc 回预览）→ countdown（3s，Esc 回确认条）
 *   → recording（整窗鼠标穿透；出口只有停止条）→ 完成/失败事件 → 后端关窗。
 *
 * 🔴 本窗不承担任何「失败展示」职责（2026-10-06 实录踩坑后移除 FatalCard/failed 态）：
 * 会话收尾由后端权威执行（清槽 + destroy 本窗，见 session::start），错误走主窗
 * toast / HUD。启动失败（rec_start 同步报错）用非阻断玻璃条提示——此时交互从未
 * 被穿透剥夺，重试 / 重画 / Esc 都是活路。选屏交互 = 方案 A（2026-10-05 设计稿）：
 * 悬停哪个窗口哪个亮，单击就录它；窗口矩形是采纳瞬间的静态区域，录制中窗口移动
 * 不跟随（尺寸标签已写明）。
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
import { ConfirmBar, CountdownOverlay, PreviewHintBar, Shades } from "./RecOverlayParts";
import { useRecSelectMouse, type Phase } from "@/hooks/useRecSelectMouse";

export function RecSelectOverlay({ config }: { config: Record<string, unknown> | null }) {
  const [phase, setPhase] = useState<Phase>("preview");
  const [screen, setScreen] = useState<RecScreenInfo | null>(null);
  const [countdown, setCountdown] = useState(3);
  // rec_start 同步报错（档位非法 / 选区太小 / 线程起不来等）——留在确认态用玻璃条
  // 提示，交互从未被穿透剥夺；会话内的异步失败由后端收窗 + toast/HUD 承接
  const [startErr, setStartErr] = useState<string | null>(null);
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
    }).catch(() => {
      // 几何都拿不到 = 覆盖层完全无法工作。不能留一个「看不见但吃点击」的
      // 透明全屏窗，直接自关（用户重按热键即可重试）。
      void recCloseWindows();
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

  // Esc 两级取消（§18）：预览 = 退出选屏；拖拽/确认 = 回预览；倒计时 = 回确认条。
  // recording 态没有 Esc 出口（设计稿：出口只有停止条）。
  // 🔴 方案 A 重写时这段曾被整段弄丢——界面上所有「Esc ××」文案变成空头支票，
  // 倒计时态更是完全无法取消（该态忽略鼠标事件）。守卫见 recOverlayEscapeGuard.test.ts。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (phase === "preview") {
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
      // CSS → 物理：后端吃虚拟屏物理像素（宽高对齐偶数，编码器 4:2:0 要求）。
      // 8s 看门狗：rec_start 万一在后端卡住（任何未知原因），不能把用户冻死在
      // 倒计时层——恢复交互报错，重试 / 重画 / Esc 全部可用。
      await Promise.race([
        recStart({
          x: screen.originX + Math.round(activeRect.x * dpr),
          y: screen.originY + Math.round(activeRect.y * dpr),
          w: Math.max(16, Math.round(activeRect.w * dpr) & ~1),
          h: Math.max(16, Math.round(activeRect.h * dpr) & ~1),
          quality: quality.key as RecQualityKey,
          sysAudio,
          micAudio,
        }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("启动录制超时，请重试")), 8000)),
      ]);
      // 整窗鼠标穿透：录制中画面零遮挡，出口只剩控制条（独立窗）。
      // 🔴 此后本窗的一切收尾归后端（session::start 的权威收尾）——
      // 这里不再有 failed 态，异步失败连着本窗销毁一起发生。
      await getCurrentWindow().setIgnoreCursorEvents(true);
      setPhase("recording");
    } catch (err) {
      // rec_start 同步失败：会话没起来、交互从未被穿透剥夺——留在确认态，
      // 玻璃条提示（规则 15.3 不静默），重试 / 重画 / Esc 都是活路
      setStartErr(err instanceof Error ? err.message : String(err));
      setPhase("confirm");
    }
  };

  // 会话收尾事件 → 关窗。后端已是收尾主体（清槽 + destroy），这里纯冗余保险；
  // rec-failed 不再进本窗展示（错误走主窗 toast / HUD，规则 15.1 可见性域）。
  useEffect(() => {
    const close = () => void recCloseWindows();
    const un1 = listen("rec-done", close);
    const un2 = listen("rec-discarded", close);
    const un3 = listen("rec-failed", close);
    return () => {
      void un1.then((f) => f());
      void un2.then((f) => f());
      void un3.then((f) => f());
    };
  }, []);

  if (!screen || !activeRect) return null;

  const recording = phase === "recording";
  const { hoverRect, snapRect, rectFromWindow } = mouse;
  const hovering = phase === "preview" && hoverRect !== null;

  return (
    <div
      onMouseDown={mouse.onMouseDown}
      onMouseMove={mouse.onMouseMove}
      onMouseUp={mouse.onMouseUp}
      onMouseEnter={() => void getCurrentWindow().setFocus()}
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

      {/* 预览态提示条（底部居中；方案 A 文案 + 整屏兜底 + 鼠标退出） */}
      {phase === "preview" && (
        <PreviewHintBar
          screenCssH={screen.height / dpr}
          screenW={Math.round(screen.width)}
          screenH={Math.round(screen.height)}
          onFullscreen={mouse.adoptFullscreen}
          onCancel={() => void recCloseWindows()}
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
            setStartErr(null);
            setCountdown(3);
            setPhase("countdown");
          }}
        />
      )}

      {/* 启动失败提示（rec_start 同步报错；非阻断玻璃条，重试/重画/Esc 全部可用） */}
      {phase === "confirm" && startErr && (
        <div
          className="rec-glass"
          style={{ left: activeRect.x, top: Math.max(8, activeRect.y - 78) }} /* ui-rule-ok: 动态定位（跟随选区），同文件既有模式 */
        >
          <span className="muted">⚠ {startErr}</span>
        </div>
      )}

      {/* 倒计时（只盖选区；「取消」按钮 = 鼠标出口，Esc 回选区） */}
      {phase === "countdown" && (
        <CountdownOverlay
          rect={activeRect}
          count={countdown}
          onCancel={() => setPhase("confirm")}
        />
      )}
    </div>
  );
}
