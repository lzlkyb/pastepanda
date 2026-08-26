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
 * 交互契约（对齐微信 PC 版）：框选 → 点「长截图」→ **自己滚鼠标滚轮** → 点「完成」。
 * 没有自动滚动、没有模式选择、没有预览层、不用点「下一张」。
 *
 * ❌ 为什么砍掉自动滚动：它是这个功能所有复杂度与失败的来源 —— 注入不生效、
 * 步长不可控、误判到底、模式要选。微信/Snagit 的手动路径都不靠它，
 * 用户自己滚反而又快又准。本文件只负责：持续采样 + 重叠匹配 + 实时拼接。
 */

import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { logger } from "@/lib/logger";
import { toScreenPt } from "@/lib/screenshot/geometry";
import { errText, loadImage, sleep, stripOf, thumbOf, withTimeout } from "@/lib/screenshot/imageIo";
import {
  LONGSHOT_PROGRESS,
  LONGSHOT_STRIP_W,
  type LongShotProgress,
  type LongShotQuality,
} from "@/lib/screenshot/longshotEvents";
import {
  LONG_FEATHER,
  LONG_IPC_TIMEOUT_MS,
  STABLE_PROBE_W,
} from "@/lib/screenshot/shotConstants";
import {
  cropWhiteMargins,
  drawFeathered,
  findOverlapRows,
  findStickyTop,
  framesAlike,
} from "@/lib/screenshot/stitch";
import type { Rect, ScreenInfo } from "@/lib/screenshot/types";

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
  } = params;

  const restoreShotWindow = useCallback(async () => {
    // 长截图结束/失败/被守卫强制恢复都汇到这里：解除心跳守卫，避免守卫在
    // 正常结束后的空窗期误判"无心跳"而重复强制恢复（幂等，无害但刷日志）。
    void invoke("disarm_longshot_guard").catch(() => undefined);
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

  /** 长截图：隐藏截图窗 → 持续采样 + 重叠匹配 + 实时拼接 → 用户点「完成」后出图。 */
  const startLongShot = useCallback(async () => {
    const r = selRef.current;
    if (!r || longShot || busy) return;
    abortLongRef.current = false;
    stopLongRef.current = false;
    escBurstRef.current = 0;
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
      // 守卫武装：与全局 Esc 并列的第二道逃生舱（后端心跳超时强制恢复 UI）。
      void invoke("arm_longshot_guard").catch(() => undefined);
      const [srx, sry] = toScreenPt(screen, r.x, r.y);
      const statusOk = await withTimeout(
        invoke<boolean>("open_longshot_status", {
          x: Math.round(srx),
          y: Math.round(sry),
          w: Math.max(1, Math.round(r.w)),
          h: Math.max(1, Math.round(r.h)),
        }),
        3000,
        "打开状态窗",
      ).catch((e) => {
        logger.warn("长截图状态窗打开失败（不阻断长截图）", e);
        return false;
      });
      if (!statusOk) {
        // ❌ 状态窗开不成（建窗失败/挂起超时/选区占满屏幕）= **取消本次长截图**。
        // 长截图流程会隐藏主窗，唯一可见出口就是状态窗；没有它 + 全局 Esc 若被
        // 占用，用户就"看不到也退不出"。宁可放弃这次长截图，也不能把用户困住。
        // （旧逻辑是"无法中途停止但继续"，实测这就是"只能重启电脑"的元凶之一。）
        logger.warn("长截图状态窗未打开，取消本次长截图（避免无出口死局）");
        showToast("无法打开长截图控制窗，已取消长截图", true);
        await restoreShotWindow(); // 统一收口：disarm 守卫 + 关状态窗 + 恢复主窗
        restored = true; // 已显式收口，标记掉，否则 finally 会把整套恢复再跑一遍
        return;
      }
      await withTimeout(invoke("hide_screenshot_window"), 3000, "隐藏截图窗").catch(() =>
        logger.warn("隐藏截图窗失败或超时（不阻断长截图）"),
      );
      const pieces: HTMLCanvasElement[] = [];
      /** 与 pieces 同下标：该片顶部的羽化重叠行数（首片恒为 0）。
       *  合成时第 i 片画在 yy - fades[i]，累加则只加 height - fades[i]。 */
      const fades: number[] = [];
      let prevCanvas: HTMLCanvasElement | null = null;
      let totalH = 0;
      /** 帧数硬上限（防失控）。实时拼接下一帧不等于一屏，真正卡长度的是 MAX_H。 */
      const MAX_FRAMES = 300;
      const MAX_H = 12000; // 浏览器 canvas 高度上限附近，防爆

      // 选区在屏幕坐标系的位置（循环里不变，算一次就行）
      const [rx, ry] = toScreenPt(screen, r.x, r.y);
      const rw = Math.max(1, Math.round(r.w));
      const rh = Math.max(1, Math.round(r.h));
      // （选区中心坐标已不再需要：滚轮注入与「已滚到底」查询随自动滚动一起砍了。）

      /** 当前要显示在状态窗上的提示（主窗已隐藏，toast 用户看不到 → 走进度事件 note） */
      let longNote = "";
      /** 拼接质量（学 ShareX 绿/黄/红）。只往坏里走、不会自愈：
       *  某一帧只勉强对上，整张图就已经有错位风险了，后面拼得再好也抹不掉。 */
      let quality: LongShotQuality = "ok";

      /** 等待类提示必须立刻上屏：设 longNote 的同时马上发一条进度事件。
       *  只靠"下一帧成功时顺带 note"，提示要到用户动作完成、下一帧拼上后才出现，
       *  恰恰错过用户最需要反馈的等待期。
       *  break 类提示（"已滚到底"等）不走这里——它们由循环结束后的最终 flush
       *  统一带出并附 120ms 显示宽限，避免同一提示双发。 */
      const emitNote = (text: string) => {
        longNote = text;
        void emit(LONGSHOT_PROGRESS, {
          frames: pieces.length,
          height: totalH,
          thumb: pieces.length ? thumbOf(pieces[pieces.length - 1]) : null,
          quality,
          note: text,
        } satisfies LongShotProgress);
      };

      /** 把一帧缩成小图，用来判断「画面到底变没变」。
       *  与 findOverlapRows 内部的全局变化判据同源（framesAlike / GLOBAL_DIFF_T），
       *  不另立一套阈值。 */
      const smallOf = (c: HTMLCanvasElement): ImageData | null => {
        try {
          const pw = STABLE_PROBE_W;
          const ph = Math.max(4, Math.round((c.height / c.width) * pw));
          const t = document.createElement("canvas");
          t.width = pw;
          t.height = ph;
          const tx = t.getContext("2d", { willReadFrequently: true });
          if (!tx) return null;
          tx.drawImage(c, 0, 0, pw, ph);
          return tx.getImageData(0, 0, pw, ph);
        } catch {
          return null;
        }
      };
      /** 上一帧的小图：用来区分「用户还没滚」和「滚太快、两帧没重叠」。 */
      let prevSmall: ImageData | null = null;
      /** 连续对不上的次数。单帧对不上多半只是半渲染的瞬间，不能马上怪用户。 */
      let noMatchStreak = 0;
      /** 连续多少轮采样没拼上东西（用于闲置降速，见循环头）。 */
      let idleSpins = 0;
      /** 攒够这么多新增像素才切一片：太小会把一次慢滚拼成几十片几像素高的碎片。 */
      const MIN_GROW = Math.max(24, Math.round(rh * 0.08));

      // ── 实时拼接主循环（微信式）──
      // 不注入滚动、不要求点「下一张」：用户自己滚，我们持续采样，画面一变就拼上去。
      // 全程只有两个动作 —— 滚，和点「完成」。
      //
      // ❌ 循环里不能 sleep：隐藏 WebView 的 setTimeout 会被节流到 1s 一次，
      // 采样掉到 1/s 后用户随手一滚就跨过整屏、两帧没有重叠 → 拼不上。
      // 靠 capture_region 自身的往返（~50~100ms）给循环定速：不受节流影响，
      // 天然就是 10~20 次/秒的采样率。
      let lastBeat = 0;
      for (;;) {
        if (abortLongRef.current) break;
        // 用户点了「完成」：再采一帧，把最后一点没攒够 MIN_GROW 的余量收进来再走。
        // 不补这一帧的话，用户看到的就是「最后那一小条没截进去」。
        const finishing = stopLongRef.current;
        if (pieces.length >= MAX_FRAMES || totalH >= MAX_H) {
          quality = "warn";
          longNote = "已达长度上限，先出图。没截完可以从这里再截一次接着拼";
          break;
        }
        // 心跳续期后端守卫：用户可能停下来读半天，不发心跳会被误判「前端停摆」强制夺屏。
        const nowMs = Date.now();
        if (nowMs - lastBeat >= 4000) {
          lastBeat = nowMs;
          void invoke("longshot_heartbeat").catch(() => undefined);
        }
        // ❌ 也不能完全不歇：capture_region 在快机器/小选区上可能几毫秒就返回，
        // 循环会变成烧 CPU 的空转。只在**连续多轮没拼上东西**后才歇一下：
        // 用户正在滚时一帧都不耽误，闲置时才降速（此时即使被节流到 1s 也无所谓，
        // 反正没内容可拼；一旦用户重新滚动，第一帧拼上就回到满速）。
        if (idleSpins >= 20) await sleep(200);
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
          // 诊断：每帧重叠值（sticky=吸顶带高, overlap=重叠行）。overlap<=2 = 画面没动
          logger.debug(`[长截图] 帧${pieces.length} sticky=${sticky} overlap=${overlap}`);
          // 重叠只有个位数行 = 勉强对上，接缝很可能错位（ShareX 那个「黄」）。
          // 不能当成成功默默拼下去 —— 用户拿到错位长图却以为一切正常。
          if (overlap > 2 && overlap < LONG_FEATHER * 2) quality = "warn";
          if (overlap <= 2) {
            // 二义：要么用户还没滚（画面没变），要么滚太快了（变了但两帧没重叠）。
            // 两种都**不是**要终止的错误 —— 保持锚点不动，继续采样等用户。
            // （旧实现在这里判「已滚到底」并 break，那是自动滚动时代的逻辑；
            //   现在终止权完全在用户手里，他不点「完成」就一直等。）
            const curSmall = smallOf(piece);
            const still = prevSmall && curSmall ? framesAlike(prevSmall, curSmall) : false;
            if (curSmall) prevSmall = curSmall;
            if (still) {
              noMatchStreak = 0; // 没滚不算「对不上」
            } else {
              noMatchStreak += 1;
              // 单帧对不上多半只是半渲染的瞬间，下一次采样（~100ms 后）就好了。
              // 连续 3 次才提示，免得把渲染抖动报成用户的错。
              if (noMatchStreak === 3) {
                quality = "warn";
                emitNote("滚太快了，往回滚一点让画面有重叠");
              }
            }
            idleSpins += 1;
            if (finishing) break;
            continue;
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
        // ❌ 旧实现有一条「grow < 选区高 10% 判为误匹配并 break」的守卫。
        // 那条守卫的前提是「一帧 ≈ 一屏」，而实时拼接下小增量是常态（用户慢滚时
        // 每次采样只推进几十像素），照旧逻辑会把正常滚动当成故障直接终止。
        // 改为：攒不够 MIN_GROW 就不切片、保持锚点继续采样，让增量自己长大。
        // 收尾那一帧（finishing）阈值降到 2px，不让最后一小条掉队。
        if (grow < (finishing ? 2 : MIN_GROW)) {
          idleSpins += 1;
          if (finishing) break;
          continue;
        }
        pieces.push(append);
        fades.push(fade);
        totalH += grow;
        prevCanvas = piece;
        // 推进成功：重置「对不上」与「空转」计数，并把小图锚点推到当前帧。
        noMatchStreak = 0;
        idleSpins = 0;
        prevSmall = smallOf(piece) ?? prevSmall;
        // 成功推进一帧就清掉旧提示：否则"画面没变化"这类等待期提示会跟着
        // 之后每一帧的进度事件反复出现（stale 文案串味）。
        longNote = "";
        // 上报进度给状态小窗（截图窗自己已经隐藏，这是唯一看得见的地方）
        void emit(LONGSHOT_PROGRESS, {
          frames: pieces.length,
          height: totalH,
          thumb: thumbOf(piece),
          quality,
          // 实时长图预览的增量条：append 的最上面 fade 行是与上一片重叠的羽化行（不占高），
          // 真正新增的内容从 fade 开始、高 grow —— 跟 totalH 的计法保持一致。
          // （首帧 append = 整片 piece、fade=0、grow=整高，同一公式自然成立。）
          strip: stripOf(append, fade, grow, LONGSHOT_STRIP_W) ?? undefined,
          note: longNote || undefined,
        } satisfies LongShotProgress);
        // 心跳续期后端守卫（不 await，绝不阻塞循环）：帧间 ≤1s，远小于守卫 60s 阈值。
        void invoke("longshot_heartbeat").catch(() => undefined);

        // 收尾帧已拼上，可以走了。
        if (finishing) break;
      }
      // 一屏都没多拼出来 = 本次长截图实际上没成（ShareX 那个「红」）。
      if (pieces.length <= 1) quality = "bad";
      // 滚动阶段到此结束 —— 立刻把界面还给用户，不要让后面的合成/OCR 拖着窗口不放。
      // 旧顺序是"拼接 + 合成 + OCR 全跑完 → finally 才 show"，
      // 而长图 OCR 几十秒起步，用户看到的就是"点了长截图一直等，什么都没有"。
      // ❌ 循环因 overlap<=2 重试失败而 break 时，longNote 已设好（"该区域不响应滚动"等），
      // 但 break 后不再 emit，这条关键提示被吞 —— 用户只看到窗口恢复、没有任何说明。
      // 这里补一发最终进度（带 note），让状态窗在关闭前把真相带出来。
      if (longNote) {
        void emit(LONGSHOT_PROGRESS, {
          frames: pieces.length,
          height: totalH,
          thumb: pieces.length ? thumbOf(pieces[pieces.length - 1]) : null,
          quality,
          note: longNote,
        } satisfies LongShotProgress);
        await sleep(120); // 给状态窗一帧时间显示，再关闭
      }
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
  ]);


  // restoreShotWindow 不导出：它只被本 hook 内部的 startLongShot 使用（正常收尾 + finally 兜底）。
  return { startLongShot };
}
