import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles/theme.css";
import "../src-mobile/styles/mobile-base.css";
import "./mobile-feedback-live-2026-10-11.css";
import { MobileNotice, type MobileFeedback } from "../src-mobile/ui/MobileNotice";
import { MobileToast } from "../src-mobile/ui/MobileToast";
import { MobileToastProvider } from "../src-mobile/ui/MobileToastQueue";
import { MobileFeedbackSlot } from "../src-mobile/ui/MobileFeedbackSlot";
import { MobileConfirmSheet } from "../src-mobile/ui/MobileConfirmSheet";
import { useMobileViewport } from "../src-mobile/ui/useMobileViewport";
import ui from "../src-mobile/ui/MobileUi.module.css";

function Preview() {
  useMobileViewport();
  const [notice, setNotice] = useState<MobileFeedback | null>(null), [confirm, setConfirm] = useState<"delete" | "draft" | null>(null);
  const [dark, setDark] = useState(false), [results, setResults] = useState<{ id: number; title: string }[]>([]);
  const sequence = useRef(0);
  const toast = (title: string) => setResults(items => [...items, { id: ++sequence.current, title }]);
  return <MobileToastProvider><main className="feedback-preview">
    <header><h1>通知组件实装</h1><button className={ui.textButton} onClick={() => {
      document.documentElement.dataset.theme = dark ? "ocean" : "midnight"; setDark(!dark);
    }}>{dark ? "浅色" : "深色"}</button></header>
    <p className="preview-caption">真实组件 · 模拟结果，不进行保存、连接或删除</p>
    <MobileFeedbackSlot>{notice ? <MobileNotice {...notice} onDismiss={() => setNotice(null)} action={notice.tone === "error"
      ? <button className={ui.textButton} onClick={() => setNotice({ tone: "pending", title: "正在重新连接…", detail: "其他功能仍可使用。" })}>重试连接</button>
      : notice.tone === "pending" ? <><button className={ui.textButton} onClick={() => { setNotice(null); toast("电脑已连接（模拟）"); }}>模拟连接成功</button><button className={ui.textButton} onClick={() => setNotice(null)}>取消连接</button></> : undefined} /> : null}</MobileFeedbackSlot>
    <div className={ui.stack}>
      <button className={ui.secondary} onClick={() => toast("正文已复制（模拟）")}>复制成功</button>
      <button className={ui.secondary} onClick={() => { toast("第一项已完成（模拟）"); toast("第二项已完成（模拟）"); }}>连续结果排队</button>
      <button className={ui.secondary} onClick={() => setNotice({ tone: "error", title: "未能连接电脑", detail: "请检查电脑是否在线，再重试连接。笔记和设置仍可使用。" })}>连接失败与恢复</button>
      <button className={ui.secondary} onClick={() => setNotice({ tone: "warning", title: "3 个文件已完成，2 个未完成", detail: "已完成的文件仍保留，请在文件列表中重试未完成的项目。" })}>部分失败</button>
      <button className={ui.secondary} onClick={() => setConfirm("draft")}>保存失败时离开</button>
      <button className={ui.danger} onClick={() => setConfirm("delete")}>不可恢复的清空</button>
    </div>
    <p className="preview-caption">轻提示避开底部导航；错误留在操作附近。重试时原位置平滑更新，关闭后平滑收起。</p>
    <nav className="preview-nav" aria-label="预览导航"><span>设备</span><span>文件</span><span>知识库</span><span>设置</span></nav>
    {results.map(result => <MobileToast key={result.id} tone="success" title={result.title} onDismiss={() => setResults(items => items.filter(item => item.id !== result.id))} />)}
    <MobileConfirmSheet open={!!confirm} danger={confirm === "delete"} title={confirm === "delete" ? "清空会话历史？" : "草稿尚未保存"}
      description={confirm === "delete" ? "这些会话记录将被删除，清空后无法恢复。本预览仅模拟确认效果。" : "内容仍保留在当前页面。继续编辑，或重试保存草稿后离开。"}
      cancelLabel={confirm === "delete" ? "保留记录" : "继续编辑"} confirmLabel={confirm === "delete" ? "确认清空" : "重试保存后离开"}
      error={confirm === "draft" ? "本机保存未能完成，请重试。" : undefined} onCancel={() => setConfirm(null)} onConfirm={() => { setConfirm(null); toast("操作已完成（模拟）"); }} />
  </main></MobileToastProvider>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
