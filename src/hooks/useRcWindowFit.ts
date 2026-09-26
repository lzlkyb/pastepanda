/**
 * useRcWindowFit — 会话窗按对方画面比例自适应（方案A，2026-09-25）。
 *
 * 设计稿：design/远程电脑-会话窗壳A方案-自适应窗口与可靠三键-设计稿.html §3/§4。
 *
 * 触发点只有「对方画面的**宽高比**变化」：
 * - 首帧到达（size 从 0 变有值）→ 调一次；
 * - 下一屏 / 画面范围（整屏·主屏·单屏）变更生效 → 比例变了才重调；
 * - 同比例（±1%）不重调——远端改分辨率但比例不变时窗口纹丝不动；
 * - 全屏态不参与；最大化中由后端命令跳过（返回 skipped，静默不打扰）；
 * - 用户手动改窗口大小**不会**触发重算（本 hook 只看画面比例，不看窗口尺寸）。
 *
 * 调用是后端命令 `rc_fit_window_to_video`（lib/rcWindowOps 收口），一次触发点
 * 调一次，绝不跟手；失败 toast。StrictMode 双挂载安全：副作用全在 effect 里，
 * 基线 ref 按会话 id 重置。
 */
import { useEffect, useRef } from "react";
import { rcFitWindowToVideo } from "@/lib/rcWindowOps";

export function useRcWindowFit({
  sessionId,
  size,
  active,
  notify,
}: {
  /** 会话 id——换会话时重置比例基线（新会话即使同比例也要重适配一次）。 */
  sessionId: string;
  /** 对方画面尺寸（useRcFrames 的 size，只在宽高真正变化时才更新）。 */
  size: { w: number; h: number };
  /** false = 全屏态等不参与的场景。 */
  active: boolean;
  /** 失败上抛（toast）。 */
  notify: (msg: string, kind: "error") => void;
}) {
  // 上一次已适配的宽高比；0 = 本会话还没适配过
  const lastAspectRef = useRef(0);

  // 换会话：基线归零（组件常驻、会话可切换的路径也要每次重适配）
  useEffect(() => {
    lastAspectRef.current = 0;
  }, [sessionId]);

  useEffect(() => {
    if (!active) return;
    if (!(size.w > 0 && size.h > 0)) return;
    const aspect = size.w / size.h;
    if (
      lastAspectRef.current > 0 &&
      Math.abs(aspect - lastAspectRef.current) / lastAspectRef.current < 0.01
    ) {
      return;
    }
    lastAspectRef.current = aspect;
    void rcFitWindowToVideo(size.w, size.h, notify);
  }, [active, size.w, size.h, notify]);
}
