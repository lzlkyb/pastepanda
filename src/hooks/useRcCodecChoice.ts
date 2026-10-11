/** Persistent session state: closing the More panel must not cancel feedback or reset a request. */
import { useEffect, useRef, useState } from "react";
import { rcApplySetting, type RcQuality } from "@/lib/api/rc";
import { remoteCodecLabel } from "@/lib/utils";

export type RcCodec = "h264" | "hevc" | "av1" | "jpeg";
export function useRcCodecChoice({ sessionId, peerHevc, peerAv1, actualCodec, quality,
  connected, onQuality, onStatus, mac = /mac/i.test(navigator.platform),
}: {
  sessionId: string; peerHevc?: boolean; peerAv1?: boolean; actualCodec: string;
  quality: string; connected: boolean; mac?: boolean;
  onQuality: (q: RcQuality) => void;
  onStatus: (message: string, kind: "success" | "error" | "info") => void;
}) {
  const [requested, setRequested] = useState<RcCodec | null>(null);
  const [pending, setPending] = useState(false);
  const scope = useRef({ sessionId, alive: true, token: 0, busy: false });
  scope.current.sessionId = sessionId;
  useEffect(() => {
    const owner = scope.current;
    owner.alive = true;
    owner.busy = false;
    setRequested(null); setPending(false);
    return () => { owner.alive = false; owner.token++; owner.busy = false; };
  }, [sessionId]);
  const options = [
    { key: "h264" as const, label: "H.264", tip: "兼容性优先；实际编码以接收画面为准" },
    ...(peerHevc ? [{ key: "hevc" as const, label: "HEVC", tip: "对方已声明支持 HEVC" }] : []),
    ...(peerAv1 ? [{ key: "av1" as const, label: "AV1", tip: mac ? "Mac 原生软件解码，最高 1080p" : "对方已声明支持 AV1" }] : []),
    { key: "jpeg" as const, label: "JPEG", tip: "逐帧图片，适合兼容性排障" },
  ];
  const pick = async (codec: RcCodec) => {
    if (!connected || scope.current.busy || !options.some(o => o.key === codec)) return;
    const token = ++scope.current.token;
    const current = () => scope.current.alive && scope.current.sessionId === sessionId && scope.current.token === token;
    scope.current.busy = true; setPending(true);
    onStatus(`正在请求 ${remoteCodecLabel(codec)} 编码…`, "info");
    let lowered = false;
    try {
      if (codec === "av1" && mac && !["smooth", "balanced", "sharp"].includes(quality)) {
        const result = await rcApplySetting(sessionId, "quality", "balanced");
        if (!current()) return;
        if (result.status !== "accepted") {
          onStatus("画质切换未确认，未继续请求 AV1；请查看实际画面或重试", "info");
          return;
        }
        onQuality("balanced"); lowered = true;
        onStatus("AV1 软件接收最高 1080p，已将画质切为均衡", "info");
      }
      if (!current()) return;
      const result = await rcApplySetting(sessionId, "codec", codec);
      if (!current()) return;
      setRequested(codec);
      onStatus(result.status === "accepted"
        ? `对方已接受 ${remoteCodecLabel(codec)} 请求；实际接收编码以画面状态为准`
        : `${remoteCodecLabel(codec)} 请求未确认；请查看实际接收编码或重试`,
      result.status === "accepted" ? "success" : "info");
    } catch (error) {
      if (current()) onStatus(`编码切换失败：${error}${lowered ? "；画质已切为均衡" : ""}`, "error");
    } finally {
      if (current()) { scope.current.busy = false; setPending(false); }
    }
  };
  return { options, value: requested ?? (actualCodec || "h264"), pending, disabled: !connected || pending,
    actualLabel: actualCodec ? remoteCodecLabel(actualCodec) : "等待画面", mac, pick };
}
export type RcCodecChoice = ReturnType<typeof useRcCodecChoice>;
