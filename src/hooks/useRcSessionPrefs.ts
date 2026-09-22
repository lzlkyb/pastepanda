/**
 * useRcSessionPrefs — 会话内可调项：画质 / 画面范围 / 码率倍率。
 *
 * 三个选中值都跟**会话**绑生命周期：换会话时重置回本机配置（上一场的临时选择不该
 * 带到下一场）。D6 的 fps120 回落也在这里——对端 caps 重报后本地选中值必须跟着降档，
 * 否则下拉框会显示一个已不可选的档（RcDropdown 会回退裸 key）。
 */
import { useEffect, useState } from "react";

export function useRcSessionPrefs({
  sessionId,
  quality,
  captureScope,
  bitratePct,
  peerFps120,
}: {
  sessionId: string;
  /** 本机配置的画质档，会话建立时生效 */
  quality: string;
  /** 本机配置的画面范围（display / 某块屏） */
  captureScope: string;
  /** Q5：本机配置的码率倍率（后端在会话建立时已推给被控端）；未加载按 100 兜底 */
  bitratePct?: number;
  /** D6：对端 caps 是否仍声明 fps120 可用；undefined = 未上报，不回落 */
  peerFps120?: boolean;
}) {
  const [qPick, setQPick] = useState(quality);
  const [scopePick, setScopePick] = useState(captureScope);
  const [bitratePick, setBitratePick] = useState(bitratePct ?? 100);

  useEffect(() => {
    setQPick(quality);
    setScopePick(captureScope);
    // 依赖里带上配置值：首帧 status 尚未加载时初值按 100 兜底，status 到达后这里
    // 会把下拉纠正成真正的配置值。会话内改下拉也会回写配置，值一致，不造成跳变。
    setBitratePick(bitratePct ?? 100);
  }, [sessionId, quality, captureScope, bitratePct]);

  // D6：对端 caps 重报不可用（如范围切到多屏）时自动回落——被控端也已由
  // 能力校验/推流降档兜底，不会再按 8ms 硬跑。
  // 2026-09-22：fps144/fps165 同一处理——它们与 fps120 共享「硬编 + 单屏」前置
  // （peerFps120=false 即全被挡），回落 fps60。
  useEffect(() => {
    const isHighFps = qPick === "fps120" || qPick === "fps144" || qPick === "fps165";
    if (isHighFps && peerFps120 === false) setQPick("fps60");
  }, [qPick, peerFps120]);

  return { qPick, scopePick, bitratePick, setQPick, setScopePick, setBitratePick };
}
