import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { KbDevice } from "@/hooks/useKbSync";
import { mobileKnowledgeAssetFetch, mobileKnowledgeAssetCancel } from "@/lib/api/mobileKnowledgeAssets";
import { knowledgeAssetErrorText } from "@/lib/utils";
import { MobileNotice, type MobileFeedback } from "../ui/MobileNotice";
import { MobileSheet } from "../ui/MobileSheet";
import ui from "../ui/MobileUi.module.css";
import styles from "./KnowledgeMaintenance.module.css";

export function KnowledgeAssetSheet({ target, active, onClose, onLoaded }: {
  target: { noteId: string; src: string } | null; active: boolean; onClose: () => void; onLoaded: () => void;
}) {
  const [devices, setDevices] = useState<KbDevice[]>([]);
  const [peer, setPeer] = useState("");
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<MobileFeedback | null>(null);
  const [retry, setRetry] = useState(0);
  const request = useRef<string | null>(null);
  const action = useRef(false);
  useEffect(() => {
    if (!target || !active) return;
    let alive = true;
    setLoading(true); setReadFailed(false); setEnabled(null); setBusy(false); setFeedback(null); setDevices([]); setPeer("");
    void Promise.all([invoke<{ devices: KbDevice[] }>("kb_sync_devices"), invoke<boolean>("get_kb_sync_status")]).then(([snapshot, isEnabled]) => {
      if (!alive) return;
      setDevices(snapshot.devices); setEnabled(isEnabled);
      const candidates = snapshot.devices.filter(d => !d.paused);
      if (candidates.length === 1) setPeer(candidates[0].node_id);
    }).catch(() => { if (alive) { setReadFailed(true); setFeedback({ tone: "error", title: "知识库电脑未能读取", detail: "请重试，手机正文仍可阅读。" }); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => {
      alive = false;
      const id = request.current; request.current = null; action.current = false;
      if (id) void mobileKnowledgeAssetCancel(id).catch(() => undefined);
    };
  }, [target, active, retry]);
  const fetch = async () => {
    if (!target || action.current || !peer || !enabled) return;
    action.current = true;
    const id = crypto.randomUUID(); request.current = id; setBusy(true);
    setFeedback({ tone: "pending", title: "正在取得这张图片…", detail: "正文与已有图片仍可使用，可以停止本次下载。" });
    try {
      await mobileKnowledgeAssetFetch(id, peer, target.noteId, target.src);
      if (request.current !== id) return;
      setFeedback({ tone: "success", title: "图片已保存到手机", detail: "内容校验完成，可以返回正文查看。" });
      onLoaded();
    } catch (cause) { if (request.current === id) setFeedback({ tone: "error", title: "图片未能取得", detail: knowledgeAssetErrorText(cause) }); }
    finally { if (request.current === id) { request.current = null; action.current = false; setBusy(false); } }
  };
  const cancel = async () => {
    const id = request.current;
    if (!id) return;
    setFeedback({ tone: "pending", title: "正在停止下载…" });
    try { await mobileKnowledgeAssetCancel(id); }
    catch (cause) { if (request.current === id) setFeedback({ tone: "error", title: "停止结果尚未确认", detail: knowledgeAssetErrorText(cause) }); }
  };
  return <MobileSheet open={!!target && active} title="取得缺少的图片" onClose={onClose} footer={feedback && <MobileNotice compact {...feedback} />} actions={<>
    {busy ? <button className={ui.secondary} onClick={() => void cancel()}>停止本次下载</button> : readFailed ? <button className={ui.primary} onClick={() => setRetry(v => v + 1)}>重新读取电脑</button> : feedback?.tone === "success" ? <button className={ui.primary} onClick={onClose}>返回正文</button> : <button className={ui.primary} disabled={loading || !enabled || !peer || !devices.some(d => d.node_id === peer && !d.paused)} onClick={() => void fetch()}>取得这张图片</button>}
  </>}>
    <p className={styles.meta}>只从已授权知识库的电脑取得当前图片，单张不超过10MB。不会因为打开正文而自动联网下载。</p>
    {loading && <MobileNotice tone="pending" title="正在读取已授权电脑…" />}
    {!loading && enabled === false && <MobileNotice title="知识库同步已关闭" detail="请在知识库同步面板开启，再回来补齐图片。" />}
    {!loading && !readFailed && enabled !== null && !devices.length && <MobileNotice title="尚未连接知识库电脑" detail="远程控制配对不等于知识库授权，请先在同步面板连接。" />}
    <label className={styles.label} htmlFor="asset-peer">知识库电脑</label>
    <select id="asset-peer" className={styles.input} disabled={loading || readFailed || busy} value={peer} onChange={e => setPeer(e.target.value)}>
      <option value="">选择已授权电脑</option>{devices.map(d => <option key={d.node_id} value={d.node_id} disabled={d.paused}>{d.name}{d.paused ? "（已暂停）" : ""}</option>)}
    </select>
    <p className={styles.meta}>旧电脑暂不支持单张补图时，提示升级或到同步面板运行一次正常同步。正文可以继续阅读。</p>
  </MobileSheet>;
}
