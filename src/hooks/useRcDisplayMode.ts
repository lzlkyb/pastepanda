/**
 * useRcDisplayMode — 画面显示模式与配套会话清理：缩放档、全屏、非全屏「画面偏小」提示。
 *
 * 三件事归一处，是因为它们的生命周期完全一致：都跟**会话**走，且都只影响本机表现层。
 * 「换会话补发 key-up / 鼠标松开」也放这里——它同样只在换会话 / 卸载时触发，
 * 目的是防止对端修饰键与鼠标键卡在按下态。
 */
import { useCallback, useEffect, useState } from "react";
import { releaseModifiers } from "@/hooks/useRcInput";
import type { FitMode } from "@/lib/rcSessionStats";

export function useRcDisplayMode(
  sessionId: string,
  /** 全屏目标 = 整条会话壳（顶栏 + 画面 + 底栏）。旧版只全屏画面元素，
   *  结果全屏后「结束会话 / 画质 / 剪贴板 / 链路灯」全被挡在屏幕外，且
   *  Esc 被浏览器收去退全屏——用户没有鼠标路径可退出。现改为壳整体进
   *  全屏，所有会话控件保持可见；Esc 退全屏正好构成两级取消的第一级。 */
  fullscreenRef: React.RefObject<HTMLDivElement | null>,
) {
  const [fit, setFit] = useState<FitMode>("fit");
  const [fullscreen, setFullscreen] = useState(false);
  /** 案 A：非全屏「画面偏小」提示，「知道了」仅本会话生效 */
  const [fsHintDismissed, setFsHintDismissed] = useState(false);

  const toggleFullscreen = useCallback(() => {
    const el = fullscreenRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen().catch(() => {});
  }, [fullscreenRef]);

  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const dismissFsHint = useCallback(() => setFsHintDismissed(true), []);

  useEffect(() => {
    // 换会话：提示条恢复（上一场点过「知道了」不带到下一场），并在离开这一场时
    // 补发 key-up 与鼠标松开，防止对端键卡住。
    setFsHintDismissed(false);
    return () => {
      void releaseModifiers();
    };
  }, [sessionId]);

  return {
    fit,
    setFit,
    fullscreen,
    toggleFullscreen,
    fsHintDismissed,
    dismissFsHint,
  };
}
