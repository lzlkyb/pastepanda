/**
 * 长截图（滚动拼接）：隐藏截图窗 -> 循环 截屏+重叠匹配+滚轮 -> 恢复窗口出结果。
 *
 * 从 ScreenshotOverlay 抽出来（claude.md 第 7 条 300 行上限）。
 *
 * 这是**行为型 hook**：不拥有状态。长截图那 12 个 state/ref 仍声明在组件里 ——
 * 快捷键 effect、预览层拖拽、JSX 都要读写它们，而那些代码在组件里的位置比本 hook
 * 的调用点更靠前（本 hook 依赖 finalizeCanvas，只能在它之后调用），状态搬进来会
 * 造成 TDZ。所以这里只把逻辑封成三个 callback，依赖分组传入。
 *
 * 逻辑与注释按字节原样搬运，未改行为。
 */

import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { logger } from "@/lib/logger";
import { toScreenPt } from "@/lib/screenshot/geometry";
import { errText, loadImage, sleep, thumbOf, withTimeout } from "@/lib/screenshot/imageIo";
import { LONGSHOT_PROGRESS, type LongShotProgress } from "@/lib/screenshot/longshotEvents";
import {
  LONG_DEADLINE_MS,
  LONG_FEATHER,
  LONG_IPC_TIMEOUT_MS,
  STABLE_MAX_MS,
  STABLE_PROBE_W,
  STABLE_STEP_MS,
} from "@/lib/screenshot/shotConstants";
import {
  cropWhiteMargins,
  drawFeathered,
  findOverlapRows,
  findStickyTop,
  framesAlike,
} from "@/lib/screenshot/stitch";
import type { Rect, ScreenInfo } from "@/lib/screenshot/types";

/**
 * 后端 get_scroll_range 返回的可滚动控件范围（见 screenshot.rs）。
 *
 * ❌ n_max / n_page / n_pos 是**滚动单位**，不是像素：编辑框按行、列表按项。
 * 算预览几何只能用无单位的 extra_ratio（下方还有几屏）。
 */
interface ScrollRangeOut {
  x: number;
  y: number;
  w: number;
  h: number;
  n_max: number;
  n_page: number;
  n_pos: number;
  /** 光标下方还有几屏内容（无单位）。乘选区高度 = 要伸展的物理像素 */
  extra_ratio: number;
}
export function useLongShot(params: {
  screen: ScreenInfo | null;
  selRef: RefObject<Rect | null>;
  longShot: boolean;
  setLongShot: Dispatch<SetStateAction<boolean>>;
  busy: boolean;
  setBusy: Dispatch<SetStateAction<boolean>>;
  showToast: (text: string, ok?: boolean) => void;
  finalizeCanvas: (out: HTMLCanvasElement) => Promise<void>;
  /** 长截图控制位：状态窗按钮与全局 Esc 都写它们 */
  abortLongRef: RefObject<boolean>;
  stopLongRef: RefObject<boolean>;
  escBurstRef: RefObject<number>;
  modeLongRef: RefObject<"auto" | "manual">;
  nextLongRef: RefObject<boolean>;
  /** 「预览即默认」的预览态（预览层交互与 JSX 留在组件里） */
  longPreviewRef: RefObject<boolean>;
  setLongPreview: Dispatch<SetStateAction<boolean>>;
  setPreviewRect: Dispatch<SetStateAction<{ x: number; y: number; w: number; h: number } | null>>;
  setPreviewLabel: Dispatch<SetStateAction<string>>;
  setPreviewEndY: Dispatch<SetStateAction<number | null>>;
}) {
  const {
    screen,
    selRef,
    longShot,
    setLongShot,
    busy,
    setBusy,
    showToast,
    finalizeCanvas,
    abortLongRef,
    stopLongRef,
    escBurstRef,
    modeLongRef,
    nextLongRef,
    longPreviewRef,
    setLongPreview,
    setPreviewRect,
    setPreviewLabel,
    setPreviewEndY,
  } = params;

  const restoreShotWindow = useCallback(async () => {
    await withTimeout(invoke("close_longshot_status"), 2000, "关闭状态窗").catch(() => undefined);
    const shown = await withTimeout(invoke("show_screenshot_window"), 2000, "恢复截图窗")
      .then(() => true)
      .catch(() => false);
    if (!shown) {
      // 恢复不了就干脆关掉。留一个看不见却挡鼠标的全屏透明窗，
      // 比直接关闭糟糕得多 —— 后者至少用户能继续用电脑。
      logger.error("恢复截图窗失败，改为关闭窗口以免留下隐形覆盖层");
      void invoke("close_screenshot_window").catch(() => undefined);
    }
    setLongShot(false);
  }, [setLongShot]);

  /** V3：长截图（滚动拼接）。隐藏截图窗口 → 循环 截屏+匹配+滚轮 → 恢复窗口出结果 */
  const startLongShot = useCallback(async (captureBottomPx?: number) => {
    const r = selRef.current;
    if (!r || longShot || busy) return;
    abortLongRef.current = false;
    stopLongRef.current = false;
    escBurstRef.current = 0;
    modeLongRef.current = "auto";
    nextLongRef.current = false;
    setLongShot(true);
    let restored = false;
    try {
      // 逃生舱最先武装，而且独立于状态窗：状态窗创建失败时反而最需要它。
      // （上一版把注册写在 open_longshot_status 里且在 build() 之后，
      //   状态窗一失败就直接 return Err，全局 Esc 根本没注册上。）
      // 全局 Esc 是逃生舱第二道保险。注册失败（多见于 Esc 被别的程序全局占用）不再静默吞掉：
      // 状态窗已必现（pick_status_pos 兜底），用户仍能用“放弃”按钮退出，这里给出明确提示。
      const escOk = await withTimeout(invoke<boolean>("arm_longshot_escape"), 2000, "注册全局 Esc").catch(
        () => false,
      );
      if (!escOk) {
        logger.warn("长截图全局 Esc 注册失败，退出请用状态窗“放弃”按钮");
        showToast("全局 Esc 被占用，退出请用状态窗“放弃”按钮", true);
      }
      // 先开状态小窗再隐藏截图窗：小窗在选区外，不会被拼进长图；
      // 先开也能避免中间出现"屏幕上什么都没有"的空窗。
      // 返回 false = 选区占满屏幕、无处可放，本次无法中途停止（只能等跑完）。
      const [srx, sry] = toScreenPt(screen, r.x, r.y);
      const statusOk = await invoke<boolean>("open_longshot_status", {
        x: Math.round(srx),
        y: Math.round(sry),
        w: Math.max(1, Math.round(r.w)),
        h: Math.max(1, Math.round(r.h)),
      }).catch((e) => {
        logger.warn("长截图状态窗打开失败（不阻断长截图）", e);
        return false;
      });
      if (!statusOk) {
        logger.warn("未开长截图状态窗：选区无留白位置，本次不可中途停止");
        // 窗口马上要隐藏，先给用户看一眼再走（规则 15.3：不静默）。
        // 这是罕见路径（选区占满整块屏幕），多等 700ms 不影响正常使用。
        showToast("选区占满屏幕，本次长截图无法中途停止", true);
        await sleep(700);
      }
      await invoke("hide_screenshot_window");
      const pieces: HTMLCanvasElement[] = [];
      /** 与 pieces 同下标：该片顶部的羽化重叠行数（首片恒为 0）。
       *  合成时第 i 片画在 yy - fades[i]，累加则只加 height - fades[i]。 */
      const fades: number[] = [];
      let prevCanvas: HTMLCanvasElement | null = null;
      let totalH = 0;
      const MAX_STEPS = 20;
      const startedAt = Date.now();
      const MAX_H = 12000; // 浏览器 canvas 高度上限附近，防爆

      // 选区在屏幕坐标系的位置（循环里不变，算一次就行）
      const [rx, ry] = toScreenPt(screen, r.x, r.y);
      const rw = Math.max(1, Math.round(r.w));
      const rh = Math.max(1, Math.round(r.h));
      // 选区中心（滚动注入 + 查询滚动条到底都用屏幕坐标，算一次）
      const cx = rx + rw / 2;
      const cy = ry + rh / 2;

      /** 抓一张缩小版选区，专用于判断画面是否已渲染稳定（只截选区后这一步很便宜） */
      const probe = async (): Promise<ImageData | null> => {
        try {
          const s = await withTimeout(
            invoke<ScreenInfo>("capture_region", { x: Math.round(rx), y: Math.round(ry), w: rw, h: rh }),
            LONG_IPC_TIMEOUT_MS,
            "采样截图",
          );
          const im = await loadImage(s.dataUrl);
          const pw = STABLE_PROBE_W;
          const ph = Math.max(4, Math.round((rh / rw) * pw));
          const c = document.createElement("canvas");
          c.width = pw;
          c.height = ph;
          const cx = c.getContext("2d", { willReadFrequently: true });
          if (!cx) return null;
          cx.drawImage(im, 0, 0, pw, ph);
          return cx.getImageData(0, 0, pw, ph);
        } catch {
          return null;
        }
      };

      /** 滚动后等到画面稳定（连续两次采样一致），最多 STABLE_MAX_MS。
       *  等不到稳定点就按上限返回——宁可多等也不能截到半渲染的画面。 */
      const waitStable = async () => {
        let prevProbe: ImageData | null = null;
        for (let t = 0; t < STABLE_MAX_MS; t += STABLE_STEP_MS) {
          await sleep(STABLE_STEP_MS);
          const cur = await probe();
          if (!cur) return; // 采样失败：不阻塞主流程
          if (prevProbe && framesAlike(prevProbe, cur)) return;
          prevProbe = cur;
        }
      };

      /** 手动滚动模式：阻塞直到用户点状态窗「下一张」(next) 或 中止/停止。
       *  期间用户用鼠标自行向下滚动目标窗口，点「下一张」后主窗截当前画面拼上。
       *  轮询而非阻塞等待，确保 abort/stop 能立即唤醒退出。 */
      const waitUserScroll = () => new Promise<void>((resolve) => {
        const check = () => {
          if (nextLongRef.current) {
            nextLongRef.current = false;
            resolve();
          } else if (abortLongRef.current || stopLongRef.current) {
            resolve();
          } else {
            setTimeout(check, 120);
          }
        };
        check();
      });

      // 部分应用不响应 PostMessage 滚轮，发现画面没动时切到 SendInput 重试一次
      let wheelForceInput = false;

      /** 向选区中心注入一次向下滚轮（坐标要屏幕坐标系） */
      const scrollOnce = async () => {
        await withTimeout(
          invoke("scroll_longshot", {
            x: Math.round(cx),
            y: Math.round(cy),
            delta: -120,
            forceInput: wheelForceInput,
          }),
          LONG_IPC_TIMEOUT_MS,
          "滚动注入",
        );
      };

      /** P1：查询选区命中的可滚动控件是否已滚到底（权威终止信号）。
       *  无 WS_VSCROLL 子控件（浏览器等）→ 返回 false，交给图像重叠兜底。 */
      const getScrollBottom = () =>
        withTimeout(invoke<boolean>("get_scroll_bottom", { x: Math.round(cx), y: Math.round(cy) }),
          LONG_IPC_TIMEOUT_MS,
          "查询滚动条到底",
        ).catch(() => false);

      // stopLongRef 也要进循环条件：它表示"停下来但要出图"，与 abort 走同一个出口但结果相反
      for (let i = 0; i < MAX_STEPS && !abortLongRef.current && !stopLongRef.current; i++) {
        // 只截选区，不再截全屏再裁。原实现每帧跑一遍
        // 「全屏 BitBlt → BGRA→RGBA → RGB8 → JPEG 编码 → base64 → IPC → Image 解码 → drawImage 裁出选区」，
        // 最后一步才把大部分像素丢掉——选区占屏 1/5 就有 80% 是白做的，而这要跑最多 40 遍。
        // 总时长上限：超了就当作"停止并出图"，已拼的内容不浪费。
        // 不能让用户对着一个隐藏的窗口干等几十秒。
        // ❌ 总时长上限**只管自动模式**。它的立论是「窗口隐藏着、用户只能干等」，
        // 而手动模式下用户正在亲自滑、亲自点「下一张」——一屏 3~8 秒，25 秒才四五屏
        // 就会被静默 break，人还在滑，截图已经结束了。手动模式的终止权在用户
        // （stop / abort）与 MAX_STEPS，不在墙钟。
        if (
          (modeLongRef.current as "auto" | "manual") === "auto" &&
          Date.now() - startedAt > LONG_DEADLINE_MS
        ) {
          logger.warn(`长截图达到总时长上限 ${LONG_DEADLINE_MS}ms，按停止处理`);
          break;
        }
        const shot = await withTimeout(
          invoke<ScreenInfo>("capture_region", { x: Math.round(rx), y: Math.round(ry), w: rw, h: rh }),
          LONG_IPC_TIMEOUT_MS,
          "区域截图",
        );
        const img = await loadImage(shot.dataUrl);
        const piece = document.createElement("canvas");
        piece.width = Math.max(1, Math.round(r.w));
        piece.height = Math.max(1, Math.round(r.h));
        const pctx = piece.getContext("2d");
        if (!pctx) break;
        // 返回的已经就是选区尺寸，直接画，不再需要源矩形参数
        pctx.drawImage(img, 0, 0);
        // P2-B2 统一 DPI：每片按物理像素截（grab_rect_rgba 用屏幕 DC），画布锁死到选区标称尺寸，
        // 任何 DPI 取整/缩放偏差都被 drawImage(0,0) 拉伸归一，保证所有 piece 同一比例。
        // 若原生截图像素数与标称不符（混合 DPI 跨屏的典型征兆），记日志便于排查，不阻断拼接。
        // ⚠️ 已知限制：本归一仅保证「每片同比例」，无法修正跨显示器选区因 BitBlt 跨屏原点偏移
        // 造成的坐标错位（混合 DPI 多显示器）。根治需按显示器分块截取再拼合，本次未做。
        if (img.naturalWidth !== piece.width || img.naturalHeight !== piece.height) {
          logger.warn(
            `[长截图] 截得 ${img.naturalWidth}x${img.naturalHeight} 与选区 ${piece.width}x${piece.height} 不符（疑混合 DPI），已归一`,
          );
        }

        let append: HTMLCanvasElement;
        let visible = piece.height;
        /** 本片顶部留给羽化的重叠行数（首帧为 0）；合成时要往上叠回这么多。 */
        let fade = 0;
        if (prevCanvas) {
          // P2-A1：检测吸顶带（固定导航/表头），拼接时跳过，避免重复带 + seam 错位
          const sticky = findStickyTop(prevCanvas, piece, piece.width, piece.height);
          const overlap = findOverlapRows(prevCanvas, piece, piece.width, piece.height, sticky);
          if (overlap <= 2) {
            // 手动模式：用户点「下一张」时画面没变化（没滚或滚得极少）→ 提示，不推进不退出，
            // 等待用户真正滚动后再点「下一张」；不消耗终止逻辑（终止由用户 stop/abort 控制）。
            if ((modeLongRef.current as "auto" | "manual") === "manual") {
              showToast("画面没变化：请先向下滚动目标窗口，再点『下一张』", false);
              // ❌ 必须先等用户再点一次「下一张」再回到循环顶部。
              // 直接 continue 会跳过循环底部的 waitUserScroll，变成无等待自旋：
              // 截图→还是没变→弹提示→再截……几秒内刷完 MAX_STEPS，长截图自己结束了。
              await waitUserScroll();
              await waitStable();
              continue;
            }
            // 自动模式：画面没动 = 真到底 或 滚轮不被接受。
            // 还没试过 SendInput 就先切过去重滚一次，别把「注入方式不被接受」误判成「已到底」。
            if (!wheelForceInput) {
              wheelForceInput = true;
              logger.info("[长截图] PostMessage 滚轮似乎无效，回退 SendInput 重试");
              await scrollOnce();
              await waitStable();
              continue; // 本帧不计入，重新截一帧再判
            }
            // 已用 SendInput 仍不动：区分「滚到底」与「根本不滚」。
            // pieces 只拼了一屏（首屏）就不动 → 目标窗口不响应滚动，大概率不是长页面。
            if (pieces.length <= 1) {
              showToast("该区域不响应滚动，可能不是长页面", false);
            }
            break; // 真到底 / 不滚动，停止
          }
          // seam = 吸顶带 + 重叠行：append 从 seam 开始取，吸顶带被剔除（P2-A1）
          const seam = sticky + overlap;
          if (piece.height - seam <= 0) break;
          // P2-B1 羽化：多往上取 fade 行。这 fade 行与上一片末尾是**同一内容**（它们本就在
          // 重叠区里），合成时往上叠回去做 alpha 交叉淡化。不留这几行就没东西可淡化——
          // 旧实现把斜坡贴在空白区上，反而每条接缝多出一条半透明带。
          fade = Math.min(LONG_FEATHER, seam);
          visible = piece.height - seam + fade;
          append = document.createElement("canvas");
          append.width = piece.width;
          append.height = visible;
          append
            .getContext("2d")!
            .drawImage(piece, 0, seam - fade, piece.width, visible, 0, 0, piece.width, visible);
        } else {
          append = piece;
        }
        // 新增高度不算那 fade 行（它们叠在上一片上，不占高）
        const grow = visible - fade;
        if (totalH + grow > MAX_H) break;
        pieces.push(append);
        fades.push(fade);
        totalH += grow;
        prevCanvas = piece;
        // 上报进度给状态小窗（截图窗自己已经隐藏，这是唯一看得见的地方）
        void emit(LONGSHOT_PROGRESS, {
          frames: pieces.length,
          height: totalH,
          thumb: thumbOf(piece),
        } satisfies LongShotProgress);

        // 预览即默认：拖拽选终点 → 截到 captureBottomPx 为止（裁末帧底部，与 get_scroll_bottom 双保险）
        if (captureBottomPx != null && totalH > captureBottomPx) {
          const over = totalH - captureBottomPx;
          const last = pieces[pieces.length - 1];
          const c = document.createElement("canvas");
          c.width = last.width;
          c.height = Math.max(1, last.height - over);
          c.getContext("2d")!.drawImage(last, 0, 0);
          pieces[pieces.length - 1] = c;
          totalH -= over;
          break;
        }

        // 自动模式：先查滚动条是否到底（P1 权威信号）。已到底 → 当前帧已是最后一屏，直接停，
        // 不浪费一次"滚了却没动"的无用帧。没到底 → 注入滚动（WM_VSCROLL 优先 → 滚轮回退）后等稳定。
        // 手动模式：不自动滚动，等用户自己向下滚动并点状态窗「下一张」，再等稳定。
        if ((modeLongRef.current as "auto" | "manual") === "manual") {
          await waitUserScroll();
          await waitStable();
        } else {
          const atBottom = await getScrollBottom();
          if (atBottom) {
            logger.info("[长截图] 滚动条已到底，停止（权威终止）");
            break;
          }
          await scrollOnce();
          await waitStable();
        }
      }
      // 滚动阶段到此结束 —— 立刻把界面还给用户，不要让后面的合成/OCR 拖着窗口不放。
      // 旧顺序是"拼接 + 合成 + OCR 全跑完 → finally 才 show"，
      // 而长图 OCR 几十秒起步，用户看到的就是"点了长截图一直等，什么都没有"。
      await restoreShotWindow();
      restored = true;

      // Esc 中止，或一帧都没成功 → 不出图。
      // 原实现 abortLongRef 只跟出循环，后面照样拼接 + finalizeCanvas + 进 result 态，
      // 用户按 Esc 想取消，却得到一张半截图（违反规则 17.6 两级取消）；
      // pieces 为空时 totalH=0，还会存一张 1px 高的垃圾图。
      if (abortLongRef.current || pieces.length === 0) {
        logger.warn(
          `长截图未出图（${abortLongRef.current ? "用户中止" : "未捕获到内容"}），保持当前状态`,
        );
        // 窗口隐藏了好几秒又原样回来，不说一声就是"点了长截图什么都没发生"（规则 15.3）
        showToast(
          abortLongRef.current ? "已放弃长截图" : "长截图未捕获到内容 · 该窗口可能不响应滚轮",
          abortLongRef.current,
        );
        return; // finally 里会恢复窗口并清 longShot
      }
      // 拼接长图
      const long = document.createElement("canvas");
      long.width = Math.max(1, Math.round(r.w));
      long.height = Math.max(1, totalH);
      const lctx = long.getContext("2d");
      if (lctx) {
        // yy = 本片**新内容**的起始行。续接帧顶部那 fades[i] 行是与上一片末尾重复的
        // 内容，所以要画在 yy - fade 处、且不计入高度——同一内容互相淡入才叫交叉淡化。
        let yy = 0;
        for (let i = 0; i < pieces.length; i++) {
          const p = pieces[i];
          const fade = fades[i] ?? 0;
          if (i > 0 && fade > 0) drawFeathered(lctx, p, yy - fade, fade);
          else lctx.drawImage(p, 0, yy);
          yy += p.height - fade;
        }
        // P2-A2：去掉四周全白留白（选区比窗口略大带入的桌面白边），内容内白区不动
        const out = cropWhiteMargins(long);
        // 界面已经回来了，用 busy 态告诉用户还在处理（工具栏变淡 + "处理中…"）。
        // busy 不拦 Esc，所以这段时间用户随时可以退出。
        setBusy(true);
        try {
          await finalizeCanvas(out);
        } finally {
          setBusy(false);
        }
      }
    } catch (err) {
      logger.error("长截图失败", err);
      showToast(`长截图失败：${errText(err)}`);
    } finally {
      // 正常路径已经在循环结束后恢复过了；这里只兜异常路径（循环中途抛错）。
      if (!restored) await restoreShotWindow();
    }
    // screen 入依赖：滚轮注入要把选区中心换成屏幕坐标，依赖 screen.originX/Y
    // 下面这些是 hook 的入参（原先是组件作用域里的 ref / setter，不必进依赖表）。
    // ref 对象与 setState 的引用都是恒定的，列进来不会引起额外重建。
  }, [
    longShot,
    busy,
    finalizeCanvas,
    screen,
    showToast,
    restoreShotWindow,
    selRef,
    setLongShot,
    setBusy,
    abortLongRef,
    stopLongRef,
    escBurstRef,
    modeLongRef,
    nextLongRef,
  ]);

  /** 长截图入口（微信思维）：先探测选区命中的可滚动控件，命中有滚动条且页面明显更长
   *  则显示整页淡预览（窗口不隐藏）；否则直接走原有自动滚动（浏览器/SPA 无 Win32 滚动条时零回归）。 */
  const onLongShotPreview = useCallback(async () => {
    const r = selRef.current;
    if (!r || !screen || longShot || busy) return;
    // 探测用绝对屏幕坐标（同 get_scroll_bottom 的写法）
    const [cx, cy] = toScreenPt(screen, r.x + r.w / 2, r.y + r.h / 2);
    const range = await invoke<ScrollRangeOut | null>("get_scroll_range", {
      x: Math.round(cx),
      y: Math.round(cy),
    }).catch(() => null);
    if (!range) {
      void startLongShot();
      return;
    }
    // ❌ 下方剩多少只能用比例算：旧实现直接拿 (n_max - n_page - n_pos) 当物理像素，
    // 而记事本类控件按**行**计、列表按**项**计——一个 1000 行的文档会被当成 1000px，
    // 于是预览框高度、“整页 ≈ Npx”、“约 N 屏”全错；而拖终点又是从这套错几何
    // 算出 captureBottomPx，会导致提前截断。extra_ratio 是无单位的，乘选区高度就对了。
    const extraBelow = Math.max(0, Math.round(range.extra_ratio * r.h));
    // 页面没明显更长（不足半屏）就不做预览，直接截整页
    if (range.extra_ratio < 0.5) {
      void startLongShot();
      return;
    }
    const top = r.y;
    const maxH = screen.height - top;
    const h = Math.min(maxH, r.h + extraBelow);
    setPreviewRect({ x: r.x, y: top, w: r.w, h });
    const screens = Math.max(2, Math.round(1 + range.extra_ratio));
    setPreviewLabel(`整页约 ${screens} 屏`);
    setPreviewEndY(top + h); // 默认拖到整页底部
    longPreviewRef.current = true;
    setLongPreview(true);
  }, [
    longShot,
    busy,
    startLongShot,
    screen,
    selRef,
    longPreviewRef,
    setLongPreview,
    setPreviewRect,
    setPreviewLabel,
    setPreviewEndY,
  ]);

  // restoreShotWindow 不导出：它只被本 hook 内部的 startLongShot 使用（正常收尾 + finally 兜底）。
  return { startLongShot, onLongShotPreview };
}
