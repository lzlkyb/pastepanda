/**
 * 长截图状态小窗的内容（独立窗口 longshot-status 的根组件）。
 *
 * 交互契约对齐微信 PC 版：用户自己滚鼠标滚轮，滚过的内容实时拼上去，
 * 看够了就点「完成」。所以这个窗只做三件事：显示实时长图预览、显示进度与质量、
 * 把完成/取消发回主窗。
 *
 * ❌ 不再有「自动|手动」切换与「下一张」：自动滚动已整个砍掉（它是注入不生效、
 * 步长不可控、误判到底这一系列问题的根源）；而实时拼接不需要用户逐屏确认。
 *
 * 为什么点了不是立即结束：主窗的循环在截当前帧，最多要再跑一圈（百毫秒级）
 * 才会看到标志位。所以点完立即把按钮置为待执行态，而不是假装已经停了 ——
 * 否则又是一个"点了没反应"。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import {
  LONGSHOT_CONTROL,
  LONGSHOT_PREVIEW_H,
  LONGSHOT_PROGRESS,
  LONGSHOT_STRIP_W,
  type LongShotControl,
  type LongShotProgress,
  type LongShotQuality,
} from "@/lib/screenshot/longshotEvents";

/** 三色点的悬停解释。颜色本身传达不了「黄到底意味着什么」，必须配文字。 */
const QUALITY_TIP: Record<LongShotQuality, string> = {
  ok: "每帧都找到了充分的重叠，接缝可靠",
  warn: "有帧只勉强对上（多半是滚太快）—— 出图后请检查接缝",
  bad: "基本没拼成（只有一屏或重叠对不上）",
};

export function LongShotStatus() {
  const [p, setP] = useState<LongShotProgress>({ frames: 0, height: 0, thumb: null });
  const [pending, setPending] = useState<LongShotControl | null>(null);

  const previewRef = useRef<HTMLCanvasElement | null>(null);
  // ❌ 图片解码是异步的：strip 到得比解码快时直接画会乱序，预览里的长图就错位了。
  // 串成一条 promise 链，严格按到达顺序追加。
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  /** 把一条新增像素追加到预览画布底部（已有内容整体上移，只保留尾部）。 */
  const appendStrip = useCallback((src: string) => {
    queueRef.current = queueRef.current.then(
      () =>
        new Promise<void>((resolve) => {
          const cv = previewRef.current;
          if (!cv) return resolve();
          const img = new Image();
          img.onload = () => {
            const ctx = cv.getContext("2d");
            if (!ctx) return resolve();
            const h = Math.min(img.height, cv.height);
            // 已有内容整体上移 h，腾出底部（画布自拷贝，规范内定义行为）
            ctx.drawImage(cv, 0, -h);
            // strip 比预览区还高时只贴它的底部 —— 用户要看的是最新拼上的那段
            ctx.drawImage(img, 0, img.height - h, img.width, h, 0, cv.height - h, cv.width, h);
            // 接缝线：拼接出错就出在这里，画出来用户才看得见对没对
            ctx.fillStyle = "rgba(6, 182, 212, 0.75)";
            ctx.fillRect(0, cv.height - h, cv.width, 1);
            resolve();
          };
          img.onerror = () => resolve(); // 预览掉一条不影响拼接本身，不能卡住队列
          img.src = src;
        }),
    );
  }, []);

  useEffect(() => {
    const un = listen<LongShotProgress>(LONGSHOT_PROGRESS, (e) => {
      setP(e.payload);
      if (e.payload.strip) appendStrip(e.payload.strip);
    });
    return () => {
      void un.then((f) => f());
    };
  }, [appendStrip]);

  const send = useCallback(
    (c: LongShotControl) => {
      if (pending) return; // 两个都是终态指令，待执行期间不重复触发
      setPending(c);
      void emit(LONGSHOT_CONTROL, c);
    },
    [pending],
  );

  // 键盘快捷键：微信是 Enter 完成。状态窗是独立可见窗口，能收到按键；
  // Esc 另有后端全局热键兜底（arm_longshot_escape），这里再接一道不冲突。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") send("stop");
      else if (e.key === "Escape") send("abort");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [send]);

  return (
    <div className="ls-root">
      {/* 实时长图预览（学 QQ / 微信：边拼边显示已经拼出来的图）。
          画布内部尺寸固定（= 主窗发来的 strip 宽度），CSS 不缩放，1:1 贴上去不糊。 */}
      <canvas
        className="ls-preview-cv"
        ref={previewRef}
        width={LONGSHOT_STRIP_W}
        height={LONGSHOT_PREVIEW_H}
      />
      <div className="ls-bar">
        {p.thumb ? <img className="ls-thumb" src={p.thumb} alt="" /> : <span className="ls-spin" />}
        <div className="ls-txt">
          <div className="ls-main">
            {/* 三色点（学 ShareX）：拼接本质上是猜，把不确定性当场摊开说，
                而不是等用户拿到错位长图才发现。 */}
            <span
              className={`ls-dot ${p.quality ?? "ok"}`}
              title={QUALITY_TIP[p.quality ?? "ok"]}
            />
            已拼 <b>{p.frames}</b> 段<span className="ls-h">高 {p.height}px</span>
          </div>
          <div className="ls-sub">
            {/* 主窗已隐藏，toast 看不到 —— 提示只能经进度事件带到这里显示 */}
            {p.note
              ? p.note
              : pending === "stop"
                ? "正在收尾，等当前帧完成…"
                : pending === "abort"
                  ? "正在取消…"
                  : "向下滚鼠标滚轮，滚过的内容会自动拼上"}
          </div>
        </div>

        {/* 完成/取消是**唯一的出口**，必须紧跟进度文字、排在最不容易被裁的位置：
            .ls-bar 是 overflow:hidden + 按钮 flex-shrink:0，万一未来加元素导致横向溢出，
            被裁掉的不能是这两个。 */}
        <button
          className={`ls-btn stop${pending ? " off" : ""}`}
          onClick={() => send("stop")}
          title="用已拼的内容出图（Enter）"
        >
          完成
        </button>
        <button
          className={`ls-btn abort${pending ? " off" : ""}`}
          onClick={() => send("abort")}
          title="什么都不保留（Esc）"
        >
          取消
        </button>
      </div>
    </div>
  );
}
