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

  useEffect(() => {
    const un = listen<LongShotProgress>(LONGSHOT_PROGRESS, (e) => setP(e.payload));
    return () => {
      void un.then((f) => f());
    };
  }, []);

  const send = (c: LongShotControl) => {
    if (pending) return;
    setPending(c);
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
              : "滚动拼接中"}
        </div>
      </div>
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
