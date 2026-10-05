import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowLeft, Monitor, MousePointer2, Keyboard, Ellipsis, ChevronRight, Activity, Wifi } from "lucide-react";
import { MobileSheet } from "../src-mobile/ui/MobileSheet";
import { rttGrade, rttGradeLabel } from "../src/lib/rcSessionStats";
import session from "../src-mobile/session/RcMobileSession.module.css";
import ui from "../src-mobile/ui/MobileUi.module.css";
import "../src/styles/theme.css";
import "../src-mobile/styles/mobile-base.css";
import "./mobile-connection-details-2026-10-02.css";

// This design uses static samples. No native commands, network requests or remote inputs are sent.
const params = new URLSearchParams(location.search);
const scheme = params.get("scheme") ?? "B";
const state = params.get("state") ?? "normal";
const slow = state === "slow";
const waiting = state === "waiting";
const recovering = state === "recovering";
const rtt = waiting || recovering ? 0 : slow ? 240 : 36;
const fps = slow ? 18 : 30;
const grade = rttGrade(rtt);
const landscape = window.innerWidth > window.innerHeight;
const path = waiting ? "识别中" : slow ? "中继连接" : "局域网直连";
const quality = rttGradeLabel(grade);
const badge = recovering ? "恢复中" : waiting ? "测量中" : `${rtt} ms`;
const metricClass = slow ? "metric-slow" : waiting || recovering ? "metric-pending" : "metric-good";

function Rows({ rows }: { rows: [string, string][] }) {
  return <dl className="parameter-list">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function Details({ onQuality }: { onQuality: () => void }) {
  return <div className="connection-body">
    {recovering && <p className="connection-notice">连接不稳，正在等待恢复。恢复后继续显示实时读数。</p>}
    <div className="primary-metrics">
      <div><span>往返延时</span><strong className={metricClass}>{rtt > 0 ? <>{rtt}<small> ms</small></> : "—"}</strong><p>{recovering ? "暂不显示旧读数" : waiting ? "等待首个心跳样本" : quality}</p></div>
      <div><span>实际帧率</span><strong>{waiting || recovering ? "—" : <>{fps}<small> fps</small></>}</strong><p>{waiting || recovering ? "等待画面样本" : "当前收到的画面帧数"}</p></div>
    </div>
    <div className="trend"><div><span>往返延时 · 近 60 秒</span><span>{rtt > 0 ? "示例趋势" : "等待样本"}</span></div>
      {rtt > 0 ? <svg viewBox="0 0 320 60" role="img" aria-label={slow ? "示例延时波动，当前 240 毫秒" : "示例延时平稳，当前 36 毫秒"}><path className={metricClass} d={slow ? "M0 45 L16 38 L32 46 L48 28 L64 34 L80 22 L96 42 L112 27 L128 32 L144 12 L160 29 L176 20 L192 34 L208 10 L224 19 L240 26 L256 18 L272 9 L288 25 L304 13 L320 20" : "M0 37 L16 35 L32 37 L48 32 L64 34 L80 37 L96 31 L112 33 L128 36 L144 34 L160 29 L176 33 L192 35 L208 33 L224 35 L240 31 L256 34 L272 32 L288 36 L304 34 L320 33"} /></svg> : <p>收到测量样本后自动显示趋势。</p>}
      <div className="trend-labels"><span>60 秒前</span><span>现在</span></div>
    </div>
    <Rows rows={[
      ["连接方式", path], ["画面分辨率", waiting ? "暂无样本" : "1920 × 1080"],
      ["画面编码", waiting ? "暂无样本" : "H.264"], ["估计码率", waiting || recovering ? "暂无样本" : slow ? "0.8 Mbps" : "2.4 Mbps"],
      ["画质设置", "自动 · 由电脑调整"],
    ]} />
    <details className="advanced"><summary>高级参数<span>延时分段与丢包</span></summary><Rows rows={[
      ["画面延时（近似）", waiting || recovering ? "暂无样本" : slow ? "≈ 280 ms" : "≈ 58 ms"],
      ["采集 / 编码", waiting || recovering ? "暂无样本" : "8 / 12 ms"],
      ["传输 / 解码", waiting || recovering ? "暂无样本" : slow ? "≈ 254 / 6 ms" : "≈ 32 / 6 ms"],
      ["操作响应（近似）", "暂无样本"], ["丢包率", slow ? "1.6%" : "暂无样本"],
    ]} /><p className={ui.hint}>往返延时是心跳实测；画面延时是采集到上屏的近似值。操作响应需要接入手机输入时间；没有可靠样本时不显示数字。</p></details>
    {slow && <p className="connection-notice">延时偏高。降低画质可能减轻画面负担，但不会直接降低网络往返延时。</p>}
    <button className={ui.secondary} onClick={onQuality}><Monitor size={18} aria-hidden="true" />画面与画质<ChevronRight size={16} aria-hidden="true" /></button>
    <p className={ui.hint}>静态设计示例，数值与趋势不是当前连接的实测。</p>
  </div>;
}

function Sample() {
  const [panel, setPanel] = useState<"details" | "more" | "screen" | "demo" | null>(params.has("open") ? "details" : null);
  const [mode, setMode] = useState(false);
  const [showTools, setShowTools] = useState(true);
  const [selectedQuality, setSelectedQuality] = useState("自动");
  const entry = <button className={`metric-entry ${metricClass}`} onClick={() => setPanel("details")} aria-label={`连接详情，${badge}`}><Activity size={15} aria-hidden="true" /><span><small>延时</small>{badge}</span><ChevronRight size={12} aria-hidden="true" /></button>;
  return <div className={`${session.root} connection-sample`}>
    {!landscape && <header className={`${session.statusRow} sample-header`}>
      <button className={session.headerButton} aria-label="返回设备（示例）" onClick={() => setPanel("demo")}><ArrowLeft size={20} /></button>
      <div className="device-title"><strong>工作电脑</strong><span>{recovering ? "正在恢复连接" : "控制中"}</span></div>
      {scheme === "B" && entry}
      <button className={session.headerButton} aria-label="画面与画质" onClick={() => setPanel("screen")}><Monitor size={20} /></button>
    </header>}
    {landscape && <div className="landscape-access">{scheme === "B" && entry}<button className="tool-entry" onClick={() => {setShowTools(true); setPanel("more");}}>工具<Ellipsis size={18} /></button></div>}
    {scheme === "C" && <button className="permanent-stats" onClick={() => setPanel("details")}><Activity size={16} /><span>延时 {badge}</span><span>{waiting || recovering ? "帧率 —" : `${fps} fps`}</span><span>H.264</span><span>{waiting || recovering ? "码率 —" : slow ? "0.8 Mbps" : "2.4 Mbps"}</span><ChevronRight size={14} /></button>}
    <div className={session.controlArea}><div className={`${session.screenArea} sample-screen`}>
      <div className={session.modePill}>{mode ? "直接点击 · 点击目标位置" : "触控板 · 划动移动指针"}</div>
      <div className="desktop-example"><div className="desktop-window"><div className="desktop-title"><Monitor size={15} />工作电脑 · 远程画面示例</div><div className="desktop-content"><div className="desktop-sidebar">桌面<br />文档<br />下载<br />图片</div><div className="desktop-files"><h3>项目文件</h3><div>产品说明.pdf</div><div>演示资料</div><div>界面截图.png</div></div></div></div><div className="desktop-taskbar">工作电脑 · 示例画面</div></div>
      {recovering && <div className="recovery-banner" role="status">连接不稳，正在等待恢复<br /><span>输入暂时暂停，收到正常画面后继续。</span></div>}
      <div className="sample-caption">设计预览 · 不发送远程操作</div>
    </div></div>
    {(!landscape || showTools) && <nav className={`${session.toolbar} ${landscape ? session.toolbarCapsule : ""}`} aria-label="会话工具">
      <button className={`${session.tbBtn} ${session.tbOn}`} onClick={() => setMode(v => !v)}><MousePointer2 size={22} /><span>{mode ? "直接点击" : "触控板"}</span></button>
      <button className={session.tbBtn} onClick={() => setPanel("demo")}><Keyboard size={22} /><span>键盘</span></button>
      <button className={session.tbBtn} onClick={() => setPanel("screen")}><Monitor size={22} /><span>画面</span></button>
      <button className={session.tbBtn} onClick={() => setPanel("more")}><Ellipsis size={22} /><span>更多</span></button>
      {landscape && <button className={session.tbBtn} onClick={() => setShowTools(false)}><span>收起</span></button>}
    </nav>}
    <MobileSheet open={panel === "details"} title="连接详情" description="工作电脑 · 本次会话" onClose={() => setPanel(null)}><Details onQuality={() => setPanel("screen")} /></MobileSheet>
    <MobileSheet open={panel === "more"} title="更多" onClose={() => setPanel(null)}><div className={ui.stack}>
      <button className={ui.secondary} onClick={() => setPanel("details")}><Wifi size={18} />连接详情<span className="inline-value">{badge}</span><ChevronRight size={16} /></button>
      <button className={ui.secondary} onClick={() => setPanel("screen")}>画面与画质</button>
      <button className={ui.secondary} onClick={() => setPanel("demo")}>剪贴板</button><button className={ui.secondary} onClick={() => setPanel("demo")}>声音</button><button className={ui.danger} onClick={() => setPanel("demo")}>断开连接</button>
    </div></MobileSheet>
    <MobileSheet open={panel === "screen"} title="画面" onClose={() => setPanel(null)}><div className={ui.stack}><button className={ui.textButton} onClick={() => setPanel("details")}><ArrowLeft size={18} />返回连接详情</button><h3 className={ui.sectionHeading}>画质</h3><div className="quality-grid" role="radiogroup" aria-label="示例画质">{["自动", "清晰", "均衡", "流畅"].map(q => <button key={q} role="radio" aria-checked={q === selectedQuality} className={q === selectedQuality ? ui.primary : ui.secondary} onClick={() => setSelectedQuality(q)}>{q}</button>)}</div><p className={ui.hint}>这里只演示入口衔接；正式版本沿用现有完整画质面板。</p></div></MobileSheet>
    <MobileSheet open={panel === "demo"} title="设计示例" onClose={() => setPanel(null)}><p className={ui.description}>这里保留当前会话工具布局。此预览重点展示连接参数，不连接设备、不发送输入，也不更改设置。</p></MobileSheet>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Sample />);
