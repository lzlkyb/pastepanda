import { useEffect, useRef, useState } from "react";
import type { RcStatus } from "@/lib/api/rcTypes";
import type { useRcFrames } from "@/hooks/useRcFrames";
import { HEARTBEAT_FAIL_MS, HEARTBEAT_STALE_MS, linkStateLabel, pathKindLabel, rttGrade, rttGradeLabel, type RcLinkState } from "@/lib/rcSessionStats";
import type { RttSample } from "@/lib/rcRttTrend";

type Frames = Pick<ReturnType<typeof useRcFrames>, "visible" | "hasFrame" | "statusText" | "fps" | "codec" | "size" | "bitrateKbps" | "latencyMs" | "segCapMs" | "segEncMs" | "segNetMs" | "segDecMs" | "respMs">;
export interface MobileConnectionInfo {
  sessionId: string;
  state: RcLinkState;
  label: string;
  grade: ReturnType<typeof rttGrade>;
  rttMs: number;
  path: string;
  frames: Frames | null;
  lossPermille: number;
  samples: RttSample[];
  sampledAt: number;
}
const EMPTY: MobileConnectionInfo = { sessionId: "", state: "connecting", label: "测量中", grade: "unknown", rttMs: 0, path: "", frames: null, lossPermille: 0, samples: [], sampledAt: 0 };

/** Reuses App's status polling; the only timer presents existing samples once per second while visible. */
export function useMobileConnectionInfo(sessionId: string | undefined, status: RcStatus | null | undefined, frames: Frames) {
  const latest = useRef({ status, frames });
  latest.current = { status, frames };
  const anchor = useRef({ at: 0, age: null as number | null, lastSampleAt: 0 });
  const samples = useRef<RttSample[]>([]);
  const [info, setInfo] = useState(EMPTY);

  useEffect(() => {
    anchor.current = { at: 0, age: null, lastSampleAt: 0 };
    samples.current = [];
    setInfo({ ...EMPTY, sessionId: sessionId ?? "" });
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || status?.session?.id !== sessionId) return;
    // Anchor on every status response, even when age/RTT are unchanged; a stable LAN is not a dead link.
    anchor.current = { ...anchor.current, at: performance.now(), age: status.pong_age_ms ?? null };
    if (frames.visible && (status.rtt_ms ?? 0) > 0 && (status.pong_age_ms ?? 0) < HEARTBEAT_STALE_MS) {
      const now = Date.now();
      if (now - anchor.current.lastSampleAt >= 1000) {
        samples.current = [...samples.current.filter(s => now - s.t <= 60_000), { t: now, ms: status.rtt_ms! }].slice(-60);
        anchor.current.lastSampleAt = now;
      }
    }
  }, [status, sessionId, frames.visible]);

  useEffect(() => {
    if (!sessionId || !frames.visible) return;
    const publish = () => {
      const { status: current, frames: frame } = latest.current;
      const valid = current?.session?.id === sessionId;
      const age = anchor.current.age == null ? null : anchor.current.age + performance.now() - anchor.current.at;
      // Old peers without pong age can show RTT, but cannot honestly establish heartbeat failure.
      const state: RcLinkState = !valid ? "connecting" : current.reconnecting ? "reconnecting"
        : age != null && age >= HEARTBEAT_FAIL_MS ? "failed"
        : age != null && age >= HEARTBEAT_STALE_MS ? "unstable"
        : age != null || (current.rtt_ms ?? 0) > 0 ? "connected" : "connecting";
      const rttMs = state === "connected" ? Math.max(0, current?.rtt_ms ?? 0) : 0;
      const grade = rttGrade(rttMs);
      const sampledAt = Date.now();
      const currentSamples = samples.current.filter(s => sampledAt - s.t <= 60_000);
      const healthy = valid && state === "connected";
      setInfo({ sessionId, state, rttMs, grade, label: grade === "unknown" ? state === "connected" || state === "connecting" ? "测量中" : linkStateLabel(state) : rttGradeLabel(grade),
        path: valid ? pathKindLabel(current.path_kind) : "",
        frames: healthy && frame.hasFrame && !frame.statusText ? { ...frame,
          // A zero/missing skew means calibration is unavailable, not a trustworthy cross-device latency.
          latencyMs: current?.clock_skew_ms ? frame.latencyMs : 0,
          segNetMs: current?.clock_skew_ms ? frame.segNetMs : 0 } : null,
        lossPermille: healthy ? current.loss_permille ?? 0 : 0,
        samples: currentSamples, sampledAt });
    };
    publish();
    const timer = window.setInterval(publish, 1000);
    return () => window.clearInterval(timer);
  }, [sessionId, frames.visible, status]);

  // Do not expose the preceding session's data during the effect reset, or live numbers while hidden.
  return info.sessionId === (sessionId ?? "") && frames.visible ? info : { ...EMPTY, sessionId: sessionId ?? "" };
}
