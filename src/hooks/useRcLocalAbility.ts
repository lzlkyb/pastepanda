/**
 * useRcLocalAbility — 本机「被控端能力」：显示器列表 + 编码能力。
 *
 * 🔴 为什么单提成 hook 而不是留在设置面板里：这两个读取的宿主原本是
 * `RcAllowPanel`，而那个面板现在拆进了可折叠的「被控上限」组。折叠组收起 = 不渲染，
 * 读本机能力的 `useEffect` 就会跟着卸载，每次展开组重读一次。提到编排层之后
 * 一次挂载读一次，失败也只有一条错误条要处理。
 *
 * U3.5 的三条口径原样保留：`null` = 未知（加载中或失败），`[]` = 真的只有固定两档；
 * 读失败必须出错误条 + 重试，禁止落成「本机没这个能力」。
 */
import { useCallback, useEffect, useState } from "react";
import { rcEncodeCaps, rcListMonitors, type RcEncodeCaps, type RcMonitorInfo } from "@/lib/api/rc";
import { visibleQualities, type RcQualityOption } from "@/lib/rcQuality";

export function useRcLocalAbility() {
  const [monitors, setMonitors] = useState<RcMonitorInfo[] | null>(null);
  const [caps, setCaps] = useState<RcEncodeCaps | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadDone, setLoadDone] = useState(false);

  const reload = useCallback(async () => {
    setLoadError(null);
    setLoadDone(false);
    const [mRes, cRes] = await Promise.allSettled([rcListMonitors(), rcEncodeCaps()]);
    if (mRes.status === "fulfilled") setMonitors(mRes.value);
    else setMonitors(null);
    if (cRes.status === "fulfilled") setCaps(cRes.value);
    else setCaps(null);
    // 两条都失败时合并成一句「能力」；单条失败说清单条（U3.5：失败 ≠ 不存在）
    if (mRes.status === "rejected" && cRes.status === "rejected") {
      setLoadError("未能读取本机能力");
    } else if (cRes.status === "rejected") {
      setLoadError("未能读取本机编码能力");
    } else if (mRes.status === "rejected") {
      setLoadError("未能读取本机显示器列表");
    }
    setLoadDone(true);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 读失败 ⇒ 「未知」，界面按隐藏高帧率档 + 出错误条处理，不许当成「没有该档」。 */
  const capsUnknown = loadDone && caps === null;
  const monitorsUnknown = loadDone && monitors === null;
  const qualities: readonly RcQualityOption[] = visibleQualities({
    h264Gpu: caps?.h264_gpu,
    refreshHz: caps?.refresh_hz,
    // Q3/Q4：uhd60 档的判定还要本机 HEVC 硬编（缺了它 4K60 档在设置页永远不出现）
    hevcHw: caps?.hevc_hw,
  });

  return { monitors, caps, loadError, reload, capsUnknown, monitorsUnknown, qualities };
}

export type RcLocalAbility = ReturnType<typeof useRcLocalAbility>;
