import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowLeft, ChevronRight, Ellipsis, FolderOpen, FolderDown, FolderUp, Keyboard, Monitor, MousePointer2, Settings2, ShieldCheck } from "lucide-react";
import { MobileSheet } from "../src-mobile/ui/MobileSheet";
import { MobileFeedbackPreview as Feedback } from "./MobileFeedback.preview";
import ui from "../src-mobile/ui/MobileUi.module.css";
import app from "../src-mobile/App.module.css";
import device from "../src-mobile/devices/RcDevices.module.css";
import session from "../src-mobile/session/RcMobileSession.module.css";
import "../src/styles/theme.css";
import "../src-mobile/styles/mobile-base.css";
import "./mobile-error-feedback-2026-10-03.css";

// All outcomes are illustrative local states. This preview never invokes native or remote commands.
const params = new URLSearchParams(location.search);
const scene = params.get("scene") || "connection";
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "midnight" : "ocean";

function Preview() {
  const [open, setOpen] = useState(true);
  const [state, setState] = useState<"error" | "busy" | "success" | "dismissed">("error");
  const [toast, setToast] = useState("");
  const [picked, setPicked] = useState(scene === "files" ? "files" : "devices");
  const [clipDirection, setClipDirection] = useState<"push" | "pull">("pull");
  const busy = state === "busy";
  const retry = () => {
    if (busy) return;
    setState("busy");
    window.setTimeout(() => {
      setState(params.get("outcome") === "fail" ? "error" : "success");
    }, 1200);
  };
  const showSuccess = () => {
    setToast("已复制到手机");
    window.setTimeout(() => setToast(""), 4000);
  };
  const title = scene === "clipboard" ? clipDirection === "push" ? "未能推送到电脑" : "未能复制到手机" : scene === "files" ? "2 个文件已发送，1 个未完成" : "未能连接工作电脑";
  const detail = scene === "clipboard" ? "本次剪贴板操作未完成，可以重试。" : scene === "files" ? "另外 2 个文件已发送。重新选择「报告.pdf」即可再次发送。" : "连接请求未完成。检查电脑端 PastePanda 是否已开启，然后重试。";
  const feedback = state === "error" ? <Feedback tone={scene === "files" ? "warning" : "error"} title={title} detail={detail} onDismiss={() => setState("dismissed")} action={<button className={ui.textButton} onClick={retry}>{scene === "files" ? "重新选择文件" : "重试"}</button>} technical={`${scene === "clipboard" ? "Clipboard operation failed" : "Socket connection closed"}（示例技术详情）`} />
    : state === "busy" ? <Feedback tone="pending" title={scene === "files" ? "正在重新准备报告.pdf…" : scene === "clipboard" ? clipDirection === "push" ? "正在推送剪贴板…" : "正在取回剪贴板…" : "正在发出连接请求…"} />
    : state === "success" ? <Feedback tone="success" title={scene === "files" ? "报告.pdf 已发送，3 个文件全部完成" : scene === "clipboard" ? clipDirection === "push" ? "已推送到电脑" : "已复制到手机" : "已发出连接请求，等待电脑确认"} /> : null;

  if (scene === "components") return <main className="component-catalog">
    <Feedback tone="info" title="等待电脑确认" detail="已发出文件请求，在电脑端选择文件后继续。" />
    <Feedback tone="success" title="已发送到电脑" detail="报告.pdf 已发送完成。" />
    <Feedback tone="warning" title="2 个文件已发送，1 个未完成" detail="已完成的文件无需重复发送。" action={<button className={ui.textButton} onClick={() => setToast("前往处理报告.pdf（示例）")}>处理未完成文件</button>} />
    {feedback}
    <Feedback tone="pending" title="正在准备文件…" detail="准备结束后开始传输，可随时取消本批准备。" action={<button className={ui.textButton} onClick={() => setToast("已停止准备（示例）")}>取消准备</button>} />
    <Feedback tone="error" title="配对码已失效" detail="在电脑端生成新配对码，再重新扫码。" action={<button className={ui.textButton} onClick={() => setToast("重新扫码（示例）")}>重新扫码</button>} />
    {toast && <Feedback tone="info" variant="toast" title={toast} onDismiss={() => setToast("")} />}
  </main>;

  const navigation = <nav className={app.tabbar} aria-label="主要导航">{[["devices", "设备", Monitor], ["files", "文件", FolderOpen], ["settings", "设置", Settings2]].map(([id, label, Icon]) => {
    const Component = Icon as typeof Monitor;
    return <button key={String(id)} className={`${app.tab} ${picked === id ? app.tabActive : ""}`} onClick={() => {setPicked(String(id)); setToast("设计示例：当前只展示错误反馈场景");}}><Component size={23} aria-hidden="true" /><span>{String(label)}</span></button>;
  })}</nav>;
  const tools = <nav className={session.toolbar} aria-label="会话工具">{[["触控板", MousePointer2], ["键盘", Keyboard], ["画面", Monitor], ["更多", Ellipsis]].map(([label, Icon]) => {
    const Component = Icon as typeof Monitor;
    return <button key={String(label)} className={session.tbBtn} onClick={() => setOpen(true)}><Component size={22} aria-hidden="true" /><span>{String(label)}</span></button>;
  })}</nav>;

  if (scene === "clipboard" || scene === "landscape") return <div className={`preview-session ${scene === "landscape" ? "wide-session" : ""}`}>
    <header className={session.statusRow}><button className={session.headerButton} aria-label="返回设备" onClick={() => {setState("dismissed"); setToast("已返回设备（示例）");}}><ArrowLeft size={20} /></button><div className={session.headerIdentity}><strong className={session.statusTitle}>工作电脑</strong><span className={session.headerSubtitle}>{scene === "landscape" && state !== "success" ? "连接中断" : "控制中"}</span></div><button className={ui.textButton} onClick={() => setOpen(true)}>工具</button></header>
    {scene === "landscape" && <Feedback variant="banner" tone={busy ? "pending" : state === "success" ? "info" : "error"} title={busy ? "正在返回设备…" : state === "success" ? "已返回设备，可重新连接" : "与电脑的连接已中断 · 输入已暂停"} action={<button className={ui.textButton} disabled={busy || state === "success"} onClick={retry}>返回设备</button>} />}
    <div className="remote-picture"><div className="remote-caption"><Monitor size={24} /><strong>远程画面示例</strong><span>{scene === "landscape" && state !== "success" ? "保留最后一帧，暂停输入" : "画面继续显示"}</span></div></div>
    {tools}
    {toast && <Feedback tone="info" variant="toast" title={toast} onDismiss={() => setToast("")} />}
    <MobileSheet open={scene === "clipboard" && open} title="剪贴板" description="在手机与电脑之间交换剪贴板文字。" onClose={() => setOpen(false)}>
      <div className="preview-stack">{feedback}<button className={ui.primary} disabled={busy} onClick={() => {setClipDirection("push"); retry();}}>{busy && clipDirection === "push" ? "正在推送…" : "推到电脑"}</button><button className={ui.secondary} disabled={busy} onClick={() => {setClipDirection("pull"); retry();}}>{busy && clipDirection === "pull" ? "正在取回…" : "取到手机"}</button></div>
    </MobileSheet>
  </div>;

  return <div className={app.root}><main className="preview-page"><header className="preview-heading"><h1>{scene === "files" ? "文件" : "设备"}</h1>{scene === "connection" && <button className={ui.textButton} onClick={() => setOpen(true)}>添加</button>}</header><p className={ui.subtitle}>{scene === "files" ? "不接管画面，也能互传文件。" : "连接电脑，让工作随身。"}</p>
    {scene === "files" ? <>
      <button className={device.peerSelect} onClick={() => setToast("当前示例传输对象：工作电脑")}><Monitor size={34} /><span><small>传输对象</small><strong>工作电脑</strong><small>Windows 电脑</small></span><ChevronRight size={18} /></button>
      <div className={device.transferActions}><button className={device.primaryBtn} disabled={busy} onClick={retry}><FolderUp size={24} />发文件到电脑</button><button className={device.ghostBtn} disabled={busy} onClick={() => setToast("已请求电脑选择文件（示例）")}><FolderDown size={24} />从电脑取文件</button></div><p className={ui.hint}>取回时，电脑端需要确认并选择文件。</p>
      <div className="file-feedback">{feedback}</div><div className={ui.sectionHead}><span>传输记录</span></div><ul className={device.fileTasks}>{["产品说明.pdf", "界面截图.png", "报告.pdf"].map((name, i) => <li className={device.fileTask} key={name}><div className={device.fileTaskHead}><span className={device.fileDir}>↑ 发</span><strong className={device.fileTaskName}>{name}</strong></div><p className={i === 2 && state !== "success" ? "failed-line" : "completed-line"}>{i === 2 && state !== "success" ? busy ? "正在准备…" : "未发送成功" : "已发送"}</p></li>)}</ul><button className={ui.textButton} onClick={showSuccess}>演示复制成功提示</button>
    </> : <>
      <div className={device.channel}><div><strong>远程通道已开启</strong><p>1 台已配对设备</p></div><ShieldCheck size={22} /></div><div className={ui.sectionHead}>已配对设备</div><div className={ui.group}><button className={device.deviceCard} onClick={() => setOpen(true)}><span className={device.deviceIcon}><Monitor size={28} /></span><span className={device.deviceText}><strong>工作电脑</strong><span className={device.deviceSub}>Windows 电脑</span></span><ChevronRight size={18} /></button></div><p className={ui.hint}>点设备选择远程控制、观看或传文件。</p>
      <MobileSheet open={open} title="设备操作" onClose={() => setOpen(false)}><div className="preview-stack"><div className={device.deviceHero}><Monitor size={48} /><h2>工作电脑</h2><p>Windows 电脑</p></div>{feedback}<button className={ui.primary} disabled={busy} onClick={retry}><MousePointer2 size={19} />{busy ? "正在申请控制…" : "远程控制"}</button><button className={ui.secondary} disabled={busy} onClick={retry}>只看画面</button><button className={ui.textButton} onClick={() => setOpen(false)}>返回设备列表</button></div></MobileSheet>
    </>}
  </main>{navigation}{toast && <Feedback tone={toast === "已复制到手机" ? "success" : "info"} variant="toast" title={toast} onDismiss={() => setToast("")} />}</div>;
}

createRoot(document.getElementById("root")!).render(<Preview />);
