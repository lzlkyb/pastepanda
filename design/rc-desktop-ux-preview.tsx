import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Monitor } from "lucide-react";
import { RcA2Sidebar } from "../src/components/rc/RcA2Sidebar";
import { RcA2DeviceDetail } from "../src/components/rc/RcA2DeviceDetail";
import { RcWorkbenchSessionStrip } from "../src/components/rc/RcWorkbenchSessionStrip";
import { useRcDeviceUi } from "../src/hooks/useRcDeviceUi";
import type { RcA2Page } from "../src/lib/rcWorkbenchA2";
import type { RcTargetDevice } from "../src/lib/api/rc";
import a2 from "../src/components/rc/RemoteComputerA2.module.css";
import "../src/styles/theme.css";
import "../src/styles/globals.css";
import "./rc-desktop-ux-preview.css";

const computer: RcTargetDevice = { node_id: "demo-computer", name: "工作电脑", os: "Windows 11", source: "rc", presence: "live", conn_state: "ready", denied: false, last_seen: Date.now(), trusted: false, auto_accept: false };
const phone: RcTargetDevice = { ...computer, node_id: "demo-phone", name: "Google Pixel 9", os: "Android", source: "sync" };
function Preview() {
  const [page, setPage] = useState<RcA2Page>("files");
  const [selected, setSelected] = useState(computer.node_id);
  const [mode, setMode] = useState<"pending" | "inbound" | "idle">("pending");
  const [message, setMessage] = useState("");
  const ui = useRcDeviceUi();
  const target = selected === phone.node_id ? phone : computer;
  ui.syncPeer(selected);
  const ok = async () => true;
  return <div className="ux-preview">
    <header className="ux-intro"><h1>远程电脑 · 交互优化</h1><p>保留现有桌面风格。等待和被控期间可查看工具页，会话状态与取消入口始终可见。以下为演示数据。</p>
      <div className="ux-controls" role="group" aria-label="预览会话状态">
        {([['pending', '等待对方同意'], ['inbound', '对方正在连接本机'], ['idle', '空闲']] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={mode === key} onClick={() => setMode(key)}>{label}</button>)}
        <button type="button" onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'ocean-dark' ? 'ocean' : 'ocean-dark'; }}>切换明暗</button>
      </div>
    </header>
    <div className={`${a2.workbench} ux-window`}>
      <div className={a2.titleBar}><div className={a2.brand}><Monitor size={20}/><b>PastePanda</b><span className={a2.brandSection}>远程电脑</span></div><span className={a2.channelStatus}>远程通道已开启</span></div>
      <div className={a2.workbenchBody}>
        <RcA2Sidebar page={page} targets={[computer, phone]} selectedId={selected} busy={false} locked={mode !== "idle"} channelUp targetsLoaded onSelect={(id) => { setSelected(id); if (page !== 'files') setPage('devices'); }} onPair={() => setMessage("这里打开现有配对弹窗")} onNavigate={setPage}/>
        <div className={a2.mainColumn}>
          {mode !== "idle" && <RcWorkbenchSessionStrip peerName="工作电脑" pending={mode === 'pending'} capability="view" busy={false}
            onReturn={() => setPage('devices')} onEnd={async () => { setMode('idle'); return true; }} toast={(text) => setMessage(text)} />}
          <div className={a2.mainSurface}>
            {page === "devices" ? <RcA2DeviceDetail target={target} busy={false} locked={mode !== "idle"} historyList={[]} ui={ui} onConnect={() => setMode('pending')} onSendFiles={() => setPage('files')} onPair={() => setMessage('这里打开现有远程配对弹窗')} onSetAllowed={ok} onSetTrust={ok} onSetAutoAccept={ok} onForget={ok} onRename={ok} onSetTags={ok} onSetRemark={ok} onViewHistory={() => setPage('history')} toast={(text) => setMessage(text)}/> :
            <section className="ux-tool-page">
              <h2>{page === "files" ? `文件 · ${target.name}` : page === "history" ? `会话记录 · ${target.name}` : "设置"}</h2>
              {page === "files" ? <><p>当前设备的记录和错误只显示在当前设备下。接收规则以本机授权为准。</p><div className="ux-controls"><button type="button" onClick={() => setMessage('这里打开现有文件选择窗口')}>传文件</button><button type="button" onClick={() => setMessage('这里打开现有文件请求流程')}>向对方要文件</button><button type="button" onClick={() => setMessage(`已清空 ${target.name} 的已结束记录（演示）`)}>清空此设备已结束记录</button></div><div className="ux-empty">这台设备还没有传输记录。选择文件即可发给对方。</div></> : page === "history" ? <><p>从设备详情进入时，默认只显示这台设备的记录。</p><div className="ux-empty">这台设备还没有会话记录。</div></> : <><div className="ux-setting"><div><b>文件接收目录</b><p>目录读取失败，请重试。</p></div><button type="button" onClick={() => setMessage('目录已重新读取（演示）')}>重试</button><button type="button" onClick={() => setMessage('这里打开现有目录选择窗口')}>更改</button></div><p>“只看 / 可控”保留现有外观，选中状态也能被读屏识别。</p></>}
            </section>}
          </div>
        </div>
      </div>
    </div>
    <p className="ux-feedback" role="status">{message || "试试：等待中点文件、记录、设置；或进入设备详情输入备注，收起再展开。"}</p>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Preview/>);
