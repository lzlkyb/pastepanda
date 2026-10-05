import { useCallback, useEffect, useRef, useState } from "react";
import { rcFileDefaultDir, rcFileReceiveDirSet } from "@/lib/api/rcFile";
import { permissionErrorInfo } from "@/lib/utils";
import { rcErrorText } from "./rcErrorText";

/** 每次显示时校准目录；推送接受与取回请求共用后端取值口。隐藏时可缓存一次在途结果。 */
export function useMobileReceiveDir(active = true) {
  const [dir, setDir] = useState<string | null>(null);
  const [error, setError] = useState<{ text: string; canReset: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const sequence = useRef(0),
    mounted = useRef(false),
    resetting = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const load = useCallback(async (reset = false) => {
    if (resetting.current) return false;
    if (reset) resetting.current = true;
    const seq = ++sequence.current;
    setBusy(true);
    setError(null);
    setNote("");
    try {
      const path = await (reset ? rcFileReceiveDirSet("") : rcFileDefaultDir());
      if (!mounted.current || seq !== sequence.current) return false;
      setDir(path);
      if (reset) setNote("已恢复默认接收位置，请重新取文件。");
      return true;
    } catch (err) {
      if (mounted.current && seq === sequence.current) {
        setDir(null);
        setError({ text: rcErrorText(err, "file-receive"), canReset: permissionErrorInfo(err, "file-receive")?.kind === "file-receive" });
      }
      return false;
    } finally {
      if (reset) resetting.current = false;
      if (mounted.current && seq === sequence.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    if (active) void load();
  }, [active, load]);
  return {
    dir,
    busy,
    note,
    clearNote: () => setNote(""),
    error: error?.text ?? null,
    canReset: error?.canReset ?? false,
    retry: () => void load(),
    reset: () => load(true),
  };
}
