import { useEffect, useRef, useState } from "react";
import { sendFilesToPeer } from "./rcSendFiles";
import { rcErrorText } from "./rcErrorText";

/** 文件页在切页时保留，上传与提示生命周期一致；busy 不与完成文案混用。 */
export function useMobileFileSend(onStatus?: (text: string | null, error?: boolean) => void, selectedPeer?: string | null) {
  const [receiptPeer, setReceiptPeer] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const locked = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  const visible = selectedPeer === undefined || selectedPeer === receiptPeer;
  useEffect(() => {
    onStatus?.(visible ? error ?? note : null, visible && !!error);
  }, [error, note, onStatus, visible]);
  const send = async (peer: string, name: string, files: File[]) => {
    if (locked.current || files.length === 0) return;
    locked.current = true;
    setReceiptPeer(peer);
    setSending(true);
    setCanceling(false);
    const batch = new AbortController();
    controller.current = batch;
    setError(null);
    setPartial(false);
    setNote(`正在准备 ${files.length} 个文件…`);
    try {
      const results = await sendFilesToPeer(
        peer,
        files,
        (file, done, total, index = 0) => {
          if (alive.current && !batch.signal.aborted)
            setNote(
              `正在准备文件 ${index + 1} / ${files.length}：${file} ${total > 0 ? Math.floor((done / total) * 100) : 100}%`,
            );
        },
        batch.signal,
      );
      if (!alive.current) return;
      const failed = results.filter((result) => !result.ok && (!result.canceled || result.err.includes("清理失败")));
      const submitted = results.filter((item) => item.ok).length;
      if (failed.length > 0) {
        setNote(null);
        setPartial(submitted > 0);
        const notCompleted = files.length - submitted;
        setError(`${submitted} 个文件已提交，${notCompleted} 个未完成${batch.signal.aborted ? "（已停止后续准备）" : ""}。未能提交：${failed.map((result) => `${result.name}（${rcErrorText(result.err, "file-send")}）`).join("、")}`);
      } else if (batch.signal.aborted) {
        setNote(
          `已取消后续准备${submitted ? `；${submitted} 个文件已提交，请在传输记录查看或取消。` : "，没有提交文件。"}`,
        );
      } else {
        setNote(`准备完成 ${results.length} 个文件，等 ${name || "对方"} 确认后开始传输。`);
      }
    } catch (err) {
      if (alive.current) {
        setNote(null);
        setError(rcErrorText(err, "file-send"));
      }
    } finally {
      locked.current = false;
      controller.current = null;
      if (alive.current) setCanceling(false);
      if (alive.current) setSending(false);
    }
  };
  const cancel = () => {
    if (!controller.current || controller.current.signal.aborted) return;
    controller.current.abort();
    setCanceling(true);
    setNote("正在停止准备，等待当前步骤结束并清理暂存…");
  };
  const dismissError = () => { setError(null); setPartial(false); };
  return { sending, canceling, note: visible ? note : null, error: visible ? error : null, partial, dismissError, dismissNote: () => setNote(null), send, cancel };
}
