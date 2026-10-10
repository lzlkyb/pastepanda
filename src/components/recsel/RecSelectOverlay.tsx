/**
 * RecSelectOverlay — 录屏选区覆盖层（全屏透明窗，rec.html 入口）。
 *
 * 状态机（§18 轻预览优先，两级取消）：
 *   preview（悬停高亮窗口；**条上就有「开始录制」/Enter = 录当前目标**）
 *   → 拖拽自定义 / 单击采纳 → confirm（确认条可改档位与音源；Esc 回预览）
 *   → countdown（3s，Esc 回确认条）→ recording（整窗鼠标穿透；出口只有停止条）
 *   → 完成/失败事件 → 后端关窗。
 *
 * 五期甲案（2026-10-10）：零基础用户从热键到成片只需「按 Enter / 点开始录制」一步
 * （默认整屏，行业基线）；要录窗口就悬停再点同一枚按钮。画质与音源收进 ⋯，结果留
 * 在条上当徽标。「目标一旦成立就粘住」（useRecSelectMouse §3）是这条最短路径的
 * 前提——否则鼠标移进玻璃条点按钮会把「录这扇窗」悄悄换成「录整屏」。
 *
 * 🔴 本窗不承担任何「失败展示」职责（2026-10-06 实录踩坑后移除 FatalCard/failed 态）：
 * 会话收尾由后端权威执行（清槽 + destroy 本窗，见 session::start），错误走主窗
 * toast / HUD。启动失败（rec_start 同步报错）用非阻断玻璃条提示——此时交互从未
 * 被穿透剥夺，重试 / 重画 / Esc 都是活路。选屏交互 = 方案 A（2026-10-05 设计稿）：
 * 悬停哪个窗口哪个亮，单击就录它；窗口矩形是采纳瞬间的静态区域，录制中窗口移动
 * 不跟随（尺寸标签已写明）。
 * 鼠标状态机在 hooks/useRecSelectMouse，键盘加速器在 hooks/useRecOverlayKeys，
 * 纯展示部件在 RecOverlayParts / 跟随选区的提示条在 RecSourceHints /
 * 画质声音浮层在 RecSettingsCluster，矩形工具在 snap。
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
import { normalizeEven, type Rect } from "./snap";
import { ConfirmBar, CountdownOverlay, PreviewBar, recTargetReadout, TargetFrames } from "./RecOverlayParts";
import { SizeHintBar, StartErrBar } from "./RecSourceHints";
import { useRecOverlayKeys } from "@/hooks/useRecOverlayKeys";
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
  // 画质/声音浮层（⋯）：两处玻璃条共用一份开合，Esc 先关它（§18 两级取消）
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  /** 当前生效的选区（CSS 坐标）。预览态/未落子 = 整屏（遮罩零面积 = 不压暗，设计稿 §1）。 */
  const dpr = window.devicePixelRatio || 1;
  const fullscreen: Rect | null = screen
    ? { x: 0, y: 0, w: screen.width / dpr, h: screen.height / dpr }
    : null;
  const activeRect: Rect | null =
    phase === "preview" || !mouse.rect ? fullscreen : mouse.rect;
  /** 读数用的预览目标：粘住的悬停窗口（没有 = 整屏）。与 activeRect 分开，预览态框选视觉仍走整屏框。 */
  const previewTarget = mouse.hoverRect ? normalizeEven(mouse.hoverRect) : null;

  /** 终点动作（预览/确认态共用）：预览态先把粘住的悬停目标落子，再进倒计时。 */
  const startFromCurrent = () => {
    if (phase === "preview") mouse.commitHovered();
    setStartErr(null);
    setSettingsOpen(false);
    setCountdown(3);
    setPhase("countdown");
  };

  // Esc 两级取消 + Enter 加速器都在 useRecOverlayKeys（改前这段曾整段丢失，
  // 守卫 recOverlayEscapeGuard.test.ts 钉的就是那个文件）。
  useRecOverlayKeys({
    phase,
    setPhase,
    settingsOpen,
    onCloseSettings: () => setSettingsOpen(false),
    onBackToPreview: backToPreview,
    onQuit: () => void recCloseWindows(),
    onStart: startFromCurrent,
  });

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
  /** 落子之后（确认/倒计时）的读数宾语：来源是窗口就叫窗口，自由框选叫选区，rect=null 叫整屏。 */
  const committedReadout = mouse.rect
    ? recTargetReadout(mouse.rect, { w: screen.width, h: screen.height }, dpr,
        rectFromWindow ? "window" : "region")
    : recTargetReadout(null, { w: screen.width, h: screen.height }, dpr);

  // 档位与音源的接线（两处玻璃条同一套，规则 11.1 分支收口在 SettingsCluster）
  const audio = {
    quality,
    onQuality: setQuality,
    sysAudio,
    micAudio,
    onSys: () => setSysAudio((v) => !v),
    onMic: () => setMicAudio((v) => !v),
    settingsOpen,
    onToggleSettings: () => setSettingsOpen((v) => !v),
  };

  return (
    <div
      onMouseDown={mouse.onMouseDown}
      onMouseMove={mouse.onMouseMove}
      onMouseUp={mouse.onMouseUp}
      onMouseEnter={() => void getCurrentWindow().setFocus()}
      style={{ width: "100%", height: "100%", position: "relative" }}
    >
      {/* 选区视觉层（遮罩 / 四边暗带 / 选区框 / 悬停高亮 / 拖拽吸附）——纯展示，见 TargetFrames */}
      <TargetFrames
        phase={phase}
        recording={recording}
        rect={activeRect}
        hoverRect={hoverRect}
        snapRect={snapRect}
        screenCss={{ w: screen.width / dpr, h: screen.height / dpr }}
      />

      {/* 选区上方提示条（非预览态）——纯展示，见 RecSourceHints */}
      {(phase === "dragging" || phase === "confirm") && (
        <SizeHintBar
          phase={phase}
          rect={activeRect}
          dpr={dpr}
          snapRect={snapRect}
          rectFromWindow={rectFromWindow}
        />
      )}

      {/* 预览条（甲案 §1）：终点 + 实时读数 + ⋯；想录整屏不必挪鼠标（默认即整屏） */}
      {phase === "preview" && (
        <PreviewBar
          readout={recTargetReadout(previewTarget, { w: screen.width, h: screen.height }, dpr)}
          hasWindowTarget={previewTarget !== null}
          onReleaseTarget={mouse.clearHover}
          screenCssH={screen.height / dpr}
          onCancel={() => void recCloseWindows()}
          onStart={startFromCurrent}
          {...audio}
        />
      )}

      {/* 确认条（选区确立后） */}
      {phase === "confirm" && (
        <ConfirmBar
          rect={activeRect}
          readout={committedReadout}
          screenCssW={screen.width / dpr}
          screenCssH={screen.height / dpr}
          onRedraw={backToPreview}
          onCancel={() => void recCloseWindows()}
          onStart={startFromCurrent}
          {...audio}
        />
      )}

      {/* 启动失败提示（rec_start 同步报错；非阻断，重试/重画/Esc 全部可用） */}
      {phase === "confirm" && startErr && <StartErrBar rect={activeRect} message={startErr} />}

      {/* 读屏播报（审查 P2）：本窗存在期间**恒在**的 live 区域。
          🔴 不能等出错了再挂这个节点——带内容一起插入的 live 区域多数读屏不播报；
          可见的玻璃提示在上方，这里只负责「状态变了要出声」。
          读数**故意不进** live 区域：它跟着光标每动一次就变，是噪音不是反馈。 */}
      <span className="rec-sr-live" role="status" aria-live="polite">
        {startErr ? `没能开始录制：${startErr}` : ""}
      </span>

      {/* 倒计时（只盖选区；「取消」按钮 = 鼠标出口，Esc 回选区） */}
      {phase === "countdown" && (
        <CountdownOverlay
          rect={activeRect}
          count={countdown}
          readout={committedReadout}
          onCancel={() => setPhase("confirm")}
        />
      )}
    </div>
  );
}
