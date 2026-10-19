import { capturePixelRatio } from "@/lib/utils";
/**
 * RecSelectOverlay — 录屏选区覆盖层（全屏透明窗，rec.html 入口）。
 *
 * 状态机（§18 轻预览优先，两级取消）：
 *   preview（悬停高亮窗口；**条上就有「开始录制」/Enter = 录当前目标**）
 *   → 拖拽自定义 / 单击采纳 → confirm（确认条可改档位与音源；Esc 回预览）
 *   → countdown（3s，进档即并行预热编码器；Esc 回确认条）
 *   → recording（归零先隐藏原生选区窗再开录；出口是独立小控制条）
 *   → 完成/失败事件 → 后端关窗。
 *
 * 五期甲案（2026-10-10）：零基础用户从热键到成片只需「按 Enter / 点开始录制」一步
 * （默认整屏，行业基线）；要录窗口就悬停再点同一枚按钮。音源常驻文字开关，画质渐进展开。
 * 「目标一旦成立就粘住」（useRecSelectMouse §3）是这条最短路径的
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
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  recCloseWindows,
  recGetScreen,
  recReady,
  recTakeRerecord,
  type RecQualityKey,
  type RecScreenInfo,
  type RecStartReq,
} from "@/lib/api/rec";
import { recQualityOf, type RecQualityItem } from "@/lib/recQuality";
import { normalizeEven, type Rect } from "./snap";
import { ConfirmBar, CountdownOverlay, PreviewBar, recTarget } from "./RecOverlayParts";
import { TargetFrames } from "./RecTargetFrames";
import { SizeHintBar, StartErrBar } from "./RecSourceHints";
import { useRecOverlayKeys } from "@/hooks/useRecOverlayKeys";
import { useRecSelectMouse, type Phase } from "@/hooks/useRecSelectMouse";
import { useRecStart } from "@/hooks/useRecStart";
import { useRecAudioCheck } from "@/hooks/useRecAudioCheck";
import styles from "./RecOffice.module.css";

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
  const audioCheck = useRecAudioCheck(sysAudio, micAudio);
  const { checkAudio } = audioCheck;
  // 画质浮层（⋯）：两处玻璃条共用一份开合，Esc 先关它（§18 两级取消）
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 条右端 `?` 的就地说明（§5.1：常驻教学行删掉后收在这里）。与画质浮层同受 Esc 两级取消管辖。
  const [helpOpen, setHelpOpen] = useState(false);

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
          const dpr = capturePixelRatio(s.width);
          setQuality(recQualityOf(plan.quality));
          setSysAudio(plan.sysAudio);
          setMicAudio(plan.micAudio);
          setRect({
            x: (plan.x - s.originX) / dpr,
            y: (plan.y - s.originY) / dpr,
            w: plan.w / dpr,
            h: plan.h / dpr,
          });
          setPhase("confirm");
          void checkAudio(() => { setCountdown(3); setPhase("countdown"); }, { sysAudio: plan.sysAudio, micAudio: plan.micAudio });
        });
      }
    }).catch((error) => {
      void emit("rec-failed", { message: String(error), hud: false });
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
  }, [config, setRect, checkAudio]);

  /** 当前生效的选区（CSS 坐标）。预览态/未落子 = 整屏（遮罩零面积 = 不压暗，设计稿 §1）。
   *  screen 是物理像素，÷dpr 转 CSS；dpr 统一走 capturePixelRatio（多屏混合缩放取屏参，
   *  不用 window.devicePixelRatio——那只是当前窗所在屏的比值）。 */
  const dpr = capturePixelRatio(screen?.width);
  const fullscreen: Rect | null = screen
    ? { x: 0, y: 0, w: screen.width / dpr, h: screen.height / dpr }
    : null;
  const activeRect: Rect | null =
    phase === "preview" || !mouse.rect ? fullscreen : mouse.rect;
  /** 读数用的预览目标：粘住的悬停窗口（没有 = 整屏）。与 activeRect 分开，预览态框选视觉仍走整屏框。 */
  const previewTarget = mouse.hoverRect ? normalizeEven(mouse.hoverRect) : null;

  /** 终点动作（预览/确认态共用）：预览态先把粘住的悬停目标落子，再进倒计时。 */
  const startFromCurrent = () => void checkAudio(() => {
    if (phase === "preview") mouse.commitHovered();
    setStartErr(null);
    setSettingsOpen(false);
    setHelpOpen(false);
    setCountdown(3);
    setPhase("countdown");
  });
  useEffect(() => { if (phase === "preview") setStartErr(null); }, [phase]);

  // Esc 两级取消 + Enter 加速器都在 useRecOverlayKeys（改前这段曾整段丢失，
  // 守卫 recOverlayEscapeGuard.test.ts 钉的就是那个文件）。
  useRecOverlayKeys({
    phase,
    setPhase,
    settingsOpen: settingsOpen || helpOpen,
    onCloseSettings: () => { setSettingsOpen(false); setHelpOpen(false); },
    onBackToPreview: () => { audioCheck.cancelCheck(); backToPreview(); },
    onQuit: () => { audioCheck.cancelCheck(); void recCloseWindows(); },
    onStart: startFromCurrent,
  });

  /**
   * 开录参数（CSS → 物理）：后端吃虚拟屏物理像素，宽高对齐偶数（编码器 4:2:0 要求）。
   * 🔴 预热与正式开录共用这一个出口（useRecStart），两处各写一遍就会算出两个键。
   */
  const buildReq = (): RecStartReq | null => {
    if (!screen || !activeRect) return null;
    return {
      x: screen.originX + Math.round(activeRect.x * dpr),
      y: screen.originY + Math.round(activeRect.y * dpr),
      w: Math.max(16, Math.round(activeRect.w * dpr) & ~1),
      h: Math.max(16, Math.round(activeRect.h * dpr) & ~1),
      quality: quality.key as RecQualityKey,
      sysAudio,
      micAudio,
    };
  };

  // 倒计时归零 → 预热已就位 → 隐身 → 开录（时序纪律与理由见 hooks/useRecStart）
  useRecStart({ phase, setPhase, countdown, setCountdown, buildReq, setStartErr });

  // 后端按会话归属销毁录制窗口。这里不响应跨窗完成事件关窗，避免旧事件误关新选区。

  if (!screen || !activeRect) return null;

  const recording = phase === "recording";
  const { hoverRect, snapRect, rectFromWindow } = mouse;
  /** 落子之后（确认/倒计时）的目标读数：来源是窗口就叫窗口，自由框选叫选区，rect=null 叫整屏。
   *  2026-10-16：读数只回尺寸，**来源改为交给胶囊上的图标**（`kind`），文字里不再出现「窗口所在区域」。 */
  const committedTarget = mouse.rect
    ? recTarget(mouse.rect, { w: screen.width, h: screen.height }, dpr,
        rectFromWindow ? "window" : "region")
    : recTarget(null, { w: screen.width, h: screen.height }, dpr);

  // 档位与音源的接线（两处玻璃条同一套，规则 11.1 分支收口在 SettingsCluster）
  const audio = {
    quality,
    onQuality: setQuality,
    sysAudio,
    micAudio,
    onSys: () => { audioCheck.clearAudioError(); setSysAudio((v) => !v); },
    onMic: () => { audioCheck.clearAudioError(); setMicAudio((v) => !v); },
    checking: audioCheck.checking,
    settingsOpen,
    onToggleSettings: () => setSettingsOpen((v) => !v),
  };

  return (
    <div
      onMouseDown={(event) => { if (!audioCheck.checking) mouse.onMouseDown(event); }}
      onMouseMove={(event) => { if (!audioCheck.checking) mouse.onMouseMove(event); }}
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
      {phase === "dragging" && (
        <SizeHintBar
          phase={phase}
          rect={activeRect}
          dpr={dpr}
          snapRect={snapRect}
          rectFromWindow={rectFromWindow}
          screenCssW={screen.width / dpr}
        />
      )}

      {/* 预览条（甲案 §1）：终点 + 实时读数 + `?`；想录整屏不必挪鼠标（默认即整屏） */}
      {phase === "preview" && (
        <PreviewBar
          target={recTarget(previewTarget, { w: screen.width, h: screen.height }, dpr)}
          hasWindowTarget={previewTarget !== null}
          onReleaseTarget={() => { audioCheck.cancelCheck(); mouse.clearHover(); }}
          screenCssH={screen.height / dpr}
          helpOpen={helpOpen}
          onToggleHelp={() => setHelpOpen((v) => !v)}
          onCancel={() => { audioCheck.cancelCheck(); void recCloseWindows(); }}
          onStart={startFromCurrent}
          {...audio}
        />
      )}

      {/* 确认条（选区确立后） */}
      {phase === "confirm" && (
        <ConfirmBar
          rect={activeRect}
          target={committedTarget}
          screenCssW={screen.width / dpr}
          screenCssH={screen.height / dpr}
          helpOpen={helpOpen}
          onToggleHelp={() => setHelpOpen((v) => !v)}
          onRedraw={() => { audioCheck.cancelCheck(); backToPreview(); }}
          onCancel={() => { audioCheck.cancelCheck(); void recCloseWindows(); }}
          onStart={startFromCurrent}
          {...audio}
        />
      )}

      {/* 启动失败提示（rec_start 同步报错；非阻断，重试/重画/Esc 全部可用） */}
      {phase === "confirm" && startErr && <StartErrBar message={startErr} />}
      {audioCheck.audioError && <div className={`rec-glass ${styles.audioError}`} role="alert"><p>{audioCheck.audioError}</p><button type="button" className="rec-btn-ghost" disabled={audioCheck.checking} onClick={startFromCurrent}>重新检查</button></div>}

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
          readout={committedTarget.text}
          onCancel={() => setPhase("confirm")}
        />
      )}
    </div>
  );
}
