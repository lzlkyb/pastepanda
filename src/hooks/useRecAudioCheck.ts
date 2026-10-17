import { useCallback, useEffect, useRef, useState } from "react";
import { recCheckAudio } from "@/lib/api/rec";

/** 按下开始时检查请求的设备，检查失败仍留在录前，由用户决定重试或关闭音源。 */
export function useRecAudioCheck(sysAudio: boolean, micAudio: boolean) {
  const [checking, setChecking] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const pending = useRef(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; pending.current = false; }, []);
  const audio = useRef({ sysAudio, micAudio });
  audio.current = { sysAudio, micAudio };
  const checkAudio = useCallback(async (ready: () => void, requested = audio.current) => {
    if (pending.current) return;
    pending.current = true;
    const gen = ++generation.current;
    setChecking(true);
    setAudioError(null);
    try {
      const { sysAudio, micAudio } = requested;
      if (sysAudio || micAudio) {
        const result = await recCheckAudio(sysAudio, micAudio);
        if (gen !== generation.current) return;
        const missing = [
          sysAudio && !result.sysAudio ? "电脑声音" : "",
          micAudio && !result.micAudio ? "麦克风" : "",
        ].filter(Boolean);
        if (missing.length) {
          setAudioError(
            `${missing.join("、")}暂时不可用。${result.warnings?.join("；") || "请检查设备连接。"} 可重新检查，或关闭对应音源后开始。`,
          );
          return;
        }
      }
      ready();
    } catch (error) {
      if (gen !== generation.current) return;
      setAudioError(
        `声音检查失败：${error instanceof Error ? error.message : String(error)}。请重试，或关闭音源后开始。`,
      );
    } finally {
      if (gen === generation.current) {
        pending.current = false;
        setChecking(false);
      }
    }
  }, []);
  const cancelCheck = useCallback(() => {
    generation.current++;
    pending.current = false;
    setChecking(false);
    setAudioError(null);
  }, []);
  return { checking, audioError, clearAudioError: cancelCheck, cancelCheck, checkAudio };
}
