import { useCallback, useEffect, useRef, useState } from "react";
import { rcExchangeCheck, rcPinPairBegin, rcShortPairCancel } from "@/lib/api/rc";
import { shortCodeFromInput } from "@/lib/rcShortCode";
import { rcErrorText } from "./rcErrorText";

type PairPhase = "idle" | "joining" | "waiting" | "cancelling" | "paired" | "error";
type Notice = { tone: "info" | "success" | "error"; text: string } | null;

/** 手机短码会合：手动发起，5 秒轮询，关闭或取消使旧请求失效。 */
export function useMobilePairing(onPaired: (name: string) => void, initialDraft = "") {
  const [peerInput, setPeerInput] = useState(initialDraft);
  const [phase, setPhase] = useState<PairPhase>("idle");
  const [notice, setNotice] = useState<Notice>(null);
  const [listening, setListening] = useState(false);
  const alive = useRef(true);
  const attempt = useRef(0);
  const phaseRef = useRef<PairPhase>("idle");
  const peer = useRef({ node_id: "", name: "" });
  const onPairedRef = useRef(onPaired);
  onPairedRef.current = onPaired;
  const transition = useCallback((next: PairPhase) => {
    // 同步记录阶段，避免同一帧重复提交或卸载时漏掉取消。
    phaseRef.current = next;
    setPhase(next);
  }, []);
  const clearNotice = useCallback(() => setNotice(null), []);
  const reportError = useCallback((error: unknown) => {
    if (alive.current) setNotice({ tone: "error", text: rcErrorText(error) });
  }, []);

  useEffect(() => {
    alive.current = true;
    const attempts = attempt;
    return () => {
      alive.current = false;
      attempts.current++;
      if (phaseRef.current === "joining" || phaseRef.current === "waiting") void rcShortPairCancel().catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (phase !== "waiting") return;
    let cancelled = false;
    let timer: number | undefined;
    const generation = attempt.current;
    const current = () => !cancelled && alive.current && generation === attempt.current;
    const check = async () => {
      try {
        const state = await rcExchangeCheck(peer.current.node_id);
        if (!current()) return;
        if (state === "paired") {
          transition("paired");
          setNotice({ tone: "success", text: `已与「${peer.current.name}」配对。` });
          onPairedRef.current(peer.current.name);
          return;
        }
      } catch (error) {
        if (!current()) return;
        transition("error");
        reportError(error);
        return;
      }
      timer = window.setTimeout(() => void check(), 5000);
    };
    void check();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [phase, transition, reportError]);

  const begin = useCallback(
    async (ownCode?: string, listen = false) => {
      if (["joining", "waiting", "cancelling"].includes(phaseRef.current)) return;
      const code = shortCodeFromInput(listen ? (ownCode ?? "") : peerInput);
      if (!code) return;
      const generation = ++attempt.current;
      setListening(listen);
      transition("joining");
      // 电脑亮码即在监听，没有额外确认弹窗；提示指向实际操作。
      setNotice({
        tone: "info",
        text: listen ? "已出示，正在等对方输入这枚码…" : "正在等待接通…请保持电脑端配对码页面打开",
      });
      try {
        const result = await rcPinPairBegin(code, listen);
        if (!alive.current || generation !== attempt.current) return;
        peer.current = result;
        transition("waiting");
        setNotice({ tone: "info", text: `已找到「${result.name}」，正在完成双方确认…` });
      } catch (error) {
        if (!alive.current || generation !== attempt.current) return;
        if (String(error).includes("已取消配对")) {
          transition("idle");
          setNotice({ tone: "info", text: "已取消配对。" });
        } else {
          transition("error");
          setNotice({ tone: "error", text: `未能配对：${rcErrorText(error)}` });
        }
      }
    },
    [peerInput, transition],
  );

  const cancelPair = useCallback(async () => {
    if (phaseRef.current === "cancelling") return;
    // 旧请求先失效，取消结束前禁止重试，避免后端取消误伤新会合。
    const generation = ++attempt.current;
    transition("cancelling");
    await rcShortPairCancel().catch(() => {});
    if (!alive.current || generation !== attempt.current) return;
    transition("idle");
    setNotice({ tone: "info", text: "已取消配对。" });
  }, [transition]);

  const editInput = useCallback(
    (value: string) => {
      setPeerInput(value);
      if (phaseRef.current === "error") transition("idle");
      setNotice(null);
    },
    [transition],
  );
  const onScanned = useCallback(
    (text: string) => {
      const code = shortCodeFromInput(text);
      if (!code) {
        setNotice({ tone: "error", text: "扫到的不是配对码（应是 PP-XXXX-XXXX 或 8 位数字）。" });
        return;
      }
      setPeerInput(code);
      if (phaseRef.current === "error") transition("idle");
      setNotice({ tone: "success", text: "已识别对方的配对码，点「开始配对」即可。" });
    },
    [transition],
  );

  return {
    peerInput,
    peerCode: shortCodeFromInput(peerInput),
    phase,
    notice,
    listening,
    busy: phase === "joining" || phase === "waiting" || phase === "cancelling",
    begin,
    cancelPair,
    editInput,
    onScanned,
    reportError,
    clearNotice,
  };
}
