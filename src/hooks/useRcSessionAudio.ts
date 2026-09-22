/**
 * useRcSessionAudio — 会话内系统声音开关（默认开）。
 *
 * 三条纪律：
 * ① 会话建立时按默认态同步一次给对端（旧版本对端解不出该事件，安全忽略）；
 * ② 开关失败必须回滚 + 说人话（C-UI3，与 RcAudioBar「对方外放」同款，禁止静默 catch）；
 * ③ 换会话不继承上一场的本地开关。
 */
import { useCallback, useEffect, useState } from "react";
import { rcAudioToggle } from "@/lib/api/rc";
import { useRcAudio } from "@/hooks/useRcAudio";
import type { ToastFn } from "@/components/Toast";

export function useRcSessionAudio(sessionId: string, toast: ToastFn) {
  const [audioOn, setAudioOn] = useState(true);
  useRcAudio(sessionId, audioOn);

  const toggleAudio = useCallback(() => {
    const next = !audioOn;
    setAudioOn(next);
    void rcAudioToggle(next).catch((e) => {
      setAudioOn((cur) => (cur === next ? !next : cur));
      toast(`声音开关失败：${typeof e === "string" && e ? e : String(e)}`, "error");
    });
  }, [audioOn, toast]);

  useEffect(() => {
    setAudioOn(true);
    void rcAudioToggle(true).catch(() => {
      // 挂载同步失败不打断画面：会话里仍可手动点开关，失败路径在 toggleAudio
    });
  }, [sessionId]);

  return { audioOn, toggleAudio };
}
