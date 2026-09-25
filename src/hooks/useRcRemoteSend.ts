/**
 * useRcRemoteSend — 会话内画质 / 画面范围 / 码率的「乐观更新 + 失败回滚」链路。
 *
 * 原 RcSessionBar（底栏）的逻辑整体搬迁（2026-09-24 控端态浮条收编），口径逐条不变：
 *
 * - 🔴 这里改的是**对方**（`rcSendInput`），失败必须回滚选中并说明。侧栏那条
 *    local 画质条曾经「点了没反应还说已保存」，同一类谎话不能在这里重演。
 * - B3：三个选中值的**最新渲染值**放在 ref 里——回滚回调在异步失败后才执行，
 *    闭包里的 props 是旧快照；回滚前用 ref 判断「UI 还停在本次设置值吗」，
 *    快速连改两档时先发请求的回滚不能覆盖后一档已落下的乐观值。
 * - 码率与画质/画面不同：它是发起端的**偏好**，远端生效后还要写本机配置
 *    （rcSetBitratePct），下一场会话由后端在建立时自动推送（outbound.rs）。
 *    本地保存失败不打断会话，但要出字（U3.5）。
 *
 * 成功反馈口径：底栏时代是内联「应用中…/已同步」浮字；浮条没有内联浮字的位，
 * 改为「下拉当前值即时变化 = 生效反馈」（乐观更新本就立刻改 UI），失败才
 * toast 报错并回滚。静默的只有成功——值已经看得见地变了。
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { rcSendInput, rcSetBitratePct, type RcQuality, type RcCaptureScope } from "@/lib/api/rc";
import { RC_BITRATE_OPTIONS, visibleQualities } from "@/lib/rcQuality";
import { scopeOptions } from "@/lib/rcScope";
import type { UseRc } from "@/hooks/useRc";

export function useRcRemoteSend({
  rc,
  quality,
  captureScope,
  bitrate,
  onPickQuality,
  onPickScope,
  onPickBitrate,
  onStatus,
}: {
  rc: UseRc;
  quality: string;
  captureScope: string;
  /** Q5：当前码率倍率（50–200，100 = 跟随链路）。 */
  bitrate: number;
  onPickQuality: (q: RcQuality) => void;
  onPickScope: (s: RcCaptureScope) => void;
  onPickBitrate: (pct: number) => void;
  onStatus: (msg: string, kind: "success" | "error" | "info") => void;
}) {
  // Q7：会话中显示器列表来自**对端**（caps 控制帧带几何信息），本机的会误导
  // （本机有 3 屏不等于对方有）。旧版本对端没有上报 → 空表，只出两项。
  const peerMonitors = useMemo(
    () => rc.status?.peer_monitors ?? [],
    [rc.status?.peer_monitors],
  );
  const scopes = useMemo(() => scopeOptions(peerMonitors), [peerMonitors]);
  // P1：高帧率档以**被控端**上报的能力为准（caps 控制帧），跑不到的档不出现在菜单里。
  // 2026-09-22：fps144/fps165 按对端屏刷新率分档（peer_refresh_hz 也是 caps 带回的）。
  const qualities = useMemo(
    () =>
      visibleQualities({
        peerFps120: rc.status?.peer_fps120,
        refreshHz: rc.status?.peer_refresh_hz,
        // Q3/Q4：uhd60 档的判定还要被控端是否支持 HEVC 硬编（缺了它 uhd60 永远被过滤）
        peerHevc: rc.status?.peer_hevc,
      }),
    [rc.status?.peer_fps120, rc.status?.peer_refresh_hz, rc.status?.peer_hevc],
  );
  // Q5：码率下拉选项。key 走字符串以复用 RcDropdown 的 string 泛型约束。
  // meta 只作用于菜单（label 右侧的短补充）；按钮上的当前值仍只写 label。
  const bitrateOptions = useMemo(
    () =>
      RC_BITRATE_OPTIONS.map((o) => ({
        key: String(o.pct),
        label: o.label,
        tip: o.tip,
        meta: o.meta,
      })),
    [],
  );

  // B3：最新渲染值（见文件头）
  const qualityRef = useRef(quality);
  const scopeRef = useRef(captureScope);
  const bitrateRef = useRef(bitrate);
  useEffect(() => {
    qualityRef.current = quality;
    scopeRef.current = captureScope;
    bitrateRef.current = bitrate;
  }, [quality, captureScope, bitrate]);

  const remoteSend = useCallback(
    async (ev: Parameters<typeof rcSendInput>[0], restore: () => void): Promise<boolean> => {
      try {
        await rcSendInput(ev);
        return true;
      } catch (e) {
        restore();
        onStatus(`改档失败：${e}`, "error");
        return false;
      }
    },
    [onStatus],
  );

  const pickQuality = useCallback(
    (k: RcQuality) => {
      if (k === quality) return;
      const was = quality as RcQuality;
      onPickQuality(k);
      void remoteSend({ kind: "set_quality", quality: k }, () => {
        if (qualityRef.current === k) onPickQuality(was);
      });
    },
    [quality, onPickQuality, remoteSend],
  );

  const pickScope = useCallback(
    (k: RcCaptureScope) => {
      if (k === captureScope) return;
      const was = captureScope as RcCaptureScope;
      onPickScope(k);
      void remoteSend({ kind: "set_capture_scope", scope: k }, () => {
        if (scopeRef.current === k) onPickScope(was);
      });
    },
    [captureScope, onPickScope, remoteSend],
  );

  const pickBitrate = useCallback(
    (k: string) => {
      const pct = Number(k);
      if (pct === bitrate) return;
      const was = bitrate;
      onPickBitrate(pct);
      void remoteSend({ kind: "set_bitrate_pct", pct }, () => {
        if (bitrateRef.current === pct) onPickBitrate(was);
      }).then((ok) => {
        if (ok) {
          // 本地偏好写失败不能静默（U3.5）：会话内已生效，下次会话可能回落旧值
          void rcSetBitratePct(pct).catch(() => {
            onStatus("本次生效，下次会话可能恢复原码率", "info");
          });
        }
      });
    },
    [bitrate, onPickBitrate, remoteSend, onStatus],
  );

  // Q7：「下一屏」——多屏高频操作不想开下拉。在**对端的物理屏**之间循环：
  // 当前在 monitor:N → monitor:(N+1) % 屏数；在整屏/主屏 → monitor:0。
  const canCycleScreen = peerMonitors.length >= 2;
  const cycleScreen = useCallback(() => {
    if (!canCycleScreen) return;
    const count = peerMonitors.length;
    const m = /^monitor:(\d+)$/.exec(scopeRef.current);
    const next = m
      ? (`monitor:${(Number(m[1]) + 1) % count}` as RcCaptureScope)
      : ("monitor:0" as RcCaptureScope);
    pickScope(next);
  }, [canCycleScreen, peerMonitors.length, pickScope]);

  return { qualities, scopes, bitrateOptions, canCycleScreen, cycleScreen, pickQuality, pickScope, pickBitrate };
}
