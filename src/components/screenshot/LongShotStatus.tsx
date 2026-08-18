/**
 * 长截图状态小窗的内容（独立窗口 longshot-status 的根组件）。
 *
 * 只做两件事：显示进度、把用户的停止/放弃发回主窗。
 *
 * 为什么点了不是立即结束：主窗的长截图循环在截当前帧 / 等画面稳定，
 * 最多要再跑一圈（百毫秒级）才会看到标志位。所以点完立即把按钮置为待执行态，
 * 而不是假装已经停了 —— 否则又是一个"点了没反应"。
 */

import { useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import {
  LONGSHOT_CONTROL,
  LONGSHOT_PROGRESS,
  type LongShotControl,
  type LongShotProgress,
} from "@/lib/screenshot/longshotEvents";

export function LongShotStatus() {
  const [p, setP] = useState<LongShotProgress>({ frames: 0, height: 0, thumb: null });
  const [pending, setPending] = useState<LongShotControl | null>(null);
  // 滚动模式：auto = 软件自动滚动；manual = 用户自己滚、点「下一张」截帧。
  const [mode, setMode] = useState<"auto" | "manual">("auto");

  useEffect(() => {
    const un = listen<LongShotProgress>(LONGSHOT_PROGRESS, (e) => setP(e.payload));
    return () => {
      void un.then((f) => f());
    };
  }, []);

  const send = (c: LongShotControl) => {
    // stop/abort 是终态指令，待执行期间禁用其它按钮（避免重复触发）
    if ((c === "stop" || c === "abort") && pending) return;
    if (c === "stop" || c === "abort") setPending(c);
    if (c === "mode_auto") setMode("auto");
    if (c === "mode_manual") setMode("manual");
    // next / mode_* 不置 pending（频繁点击，不应禁用按钮）
    void emit(LONGSHOT_CONTROL, c);
  };

  return (
    <div className="ls-bar">
      {p.thumb ? (
        <img className="ls-thumb" src={p.thumb} alt="" />
      ) : (
        <span className="ls-spin" />
      )}
      <div className="ls-txt">
        <div className="ls-main">
          已拼 <b>{p.frames}</b> 屏
          <span className="ls-h">高 {p.height}px</span>
        </div>
        <div className="ls-sub">
          {pending === "stop"
            ? "正在停止，等当前帧完成…"
            : pending === "abort"
              ? "正在放弃…"
              : mode === "manual"
                ? "手动模式：向下滚动后点「下一张」"
                : "滚动拼接中"}
        </div>
      </div>

      {/* 滚动模式切换：自动（软件滚动）/ 手动（自己滚、点下一张） */}
      <div className="ls-mode">
        <button
          className={`ls-mbtn${mode === "auto" ? " on" : ""}`}
          onClick={() => send("mode_auto")}
          title="软件自动滚动并拼接"
        >
          自动
        </button>
        <button
          className={`ls-mbtn${mode === "manual" ? " on" : ""}`}
          onClick={() => send("mode_manual")}
          title="自己滚动目标窗口，点「下一张」截帧（适合不响应自动滚动的页面）"
        >
          手动
        </button>
      </div>

      {mode === "manual" && (
        <button
          className="ls-btn next"
          onClick={() => send("next")}
          title="我已向下滚动一屏，截这一帧拼上"
        >
          下一张
        </button>
      )}

      <button
        className={`ls-btn stop${pending ? " off" : ""}`}
        onClick={() => send("stop")}
        title="用已拼的内容出图"
      >
        停止并出图
      </button>
      <button
        className={`ls-btn abort${pending ? " off" : ""}`}
        onClick={() => send("abort")}
        title="什么都不保留"
      >
        放弃
      </button>
    </div>
  );
}
