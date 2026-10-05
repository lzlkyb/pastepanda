import { useEffect, useRef, useState } from "react";
import { askCountdown, askPrompt } from "@/lib/rcFile";
import { formatBytes } from "@/lib/utils";
import type { RcFileView } from "@/hooks/useRcFile";
import styles from "./RcDevices.module.css";

export function RcMobileFileAsks({
  file,
  receiveDir,
  active,
  onHandled,
}: {
  file: RcFileView;
  receiveDir: string | null;
  active: boolean;
  onHandled?: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [working, setWorking] = useState<{ id: string; accepting: boolean } | null>(null);
  const locked = useRef(false);
  useEffect(() => {
    if (!active || file.asks.length === 0) return;
    let timer: number | undefined;
    const sync = () => {
      window.clearInterval(timer);
      setNow(Date.now());
      if (!document.hidden) timer = window.setInterval(() => setNow(Date.now()), 1000);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [active, file.asks.length]);
  const respond = async (id: string, dir: string | null) => {
    if (locked.current || file.busy) return;
    const ask = file.asks.find((item) => item.id === id);
    if (!ask || askCountdown(ask, Date.now()).remainSec === 0) {
      setNow(Date.now());
      return;
    }
    locked.current = true;
    setWorking({ id, accepting: dir !== null });
    try {
      if (await file.respond(id, dir)) onHandled?.();
    } finally {
      locked.current = false;
      setWorking(null);
    }
  };
  return (
    <>
      {file.asks.map((ask) => {
        const prompt = askPrompt(ask);
        const countdown = askCountdown(ask, now);
        const blocked = ask.kind === "pull";
        return (
          <section key={ask.id} className={styles.fileAsk} aria-label="文件接收请求">
            <div className={styles.fileAskTitle}>{prompt.title}</div>
            <div className={styles.fileAskLead}>
              {ask.kind === "push" ? `「${ask.name}」（${formatBytes(ask.size)}）→ 存进接收目录` : prompt.lead}
            </div>
            <p className={styles.fileTaskSub}>
              {countdown.remainSec === 0
                ? "请求已过期，请让对方重新发送。"
                : `等待你确认 · 还剩 ${countdown.remainSec} 秒${countdown.late ? "，即将超时" : ""}`}
            </p>
            <div className={styles.fileAskBtns}>
              <button
                className={styles.primaryBtn}
                disabled={!receiveDir || blocked || !!working || file.busy || countdown.remainSec === 0}
                onClick={() => void respond(ask.id, receiveDir)}
              >
                {working?.id === ask.id && working.accepting ? "正在接受…" : prompt.accept}
              </button>
              <button
                className={styles.ghostBtn}
                disabled={!!working || file.busy || countdown.remainSec === 0}
                onClick={() => void respond(ask.id, null)}
              >
                {working?.id === ask.id && !working.accepting ? "正在拒绝…" : prompt.deny}
              </button>
            </div>
            {blocked && (
              <p className={styles.fileTaskSub}>手机无法接受电脑取文件的请求；要传给电脑，请使用「发文件到电脑」。</p>
            )}
          </section>
        );
      })}
    </>
  );
}
