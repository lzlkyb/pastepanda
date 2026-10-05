import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChevronDown, ChevronRight, Folder, FolderDown, FolderOpen, FolderUp, KeyRound, Monitor, Plus, ScanLine, Settings2, ShieldCheck } from "lucide-react";
import { RcDeviceIcon } from "../src/components/rc/RcDeviceIcon";
import { RcDeviceMeta } from "../src/components/rc/RcDeviceMeta";
import { MobileNotice } from "../src-mobile/ui/MobileNotice";
import ui from "../src-mobile/ui/MobileUi.module.css";
import device from "../src-mobile/devices/RcDevices.module.css";
import nav from "../src-mobile/App.module.css";
import "../src/styles/theme.css";
import "../src-mobile/styles/mobile-base.css";
import "./mobile-page-header-2026-10-04.css";

type Page = "files" | "devices" | "settings";
type Variant = "current" | "A" | "B";
const pages = { files: ["文件", "不接管画面，也能互传文件。"], devices: ["设备", "连接电脑，让工作随身。"], settings: ["设置", "按自己的习惯使用 PastePanda"] };
const icons = { files: Folder, devices: Monitor, settings: Settings2 };
const variants = { current: ["调整前真机", "直角白底，标题与说明分离"], A: ["A · 融合页头（已确认）", "去掉白底，标题和说明一起随内容滚动"], B: ["B · 紧凑工具页头", "图标 + 标题说明，滚动时固定在顶部"] };

function FileContent({ demo, long }: { demo: () => void; long: boolean }) {
  return <>
    <button type="button" className={device.peerSelect} onClick={demo}>
      <RcDeviceIcon os="Windows 11" size={34} />
      <span><small>传输对象</small><strong>{long ? "LAPTOP-LZL · 我的办公室工作电脑" : "LAPTOP-LZL"}</strong><RcDeviceMeta os="Windows 11" className={device.deviceType} /></span>
      <ChevronDown size={18} aria-hidden="true" />
    </button>
    <div className={device.transferActions}>
      <button type="button" className={device.primaryBtn} onClick={demo}><FolderUp size={24} aria-hidden="true" />发文件到电脑</button>
      <button type="button" className={device.ghostBtn} onClick={demo}><FolderDown size={24} aria-hidden="true" />从电脑取文件</button>
    </div>
    <p className={ui.hint}>取回时，电脑端需要确认并选择文件。</p>
    <button type="button" className={ui.textButton} onClick={demo}><FolderOpen size={18} aria-hidden="true" />查看接收位置</button>
    <div className={ui.sectionHead}>传输记录</div>
    <p className={ui.hint}>还没有传输记录。发送或接收文件后，可以在这里查看进度。</p>
  </>;
}

function MainContent({ page, demo, long }: { page: Page; demo: () => void; long: boolean }) {
  if (page === "files") return <FileContent demo={demo} long={long} />;
  if (page === "devices") return <>
    <div className={device.channel}><div><strong>远程通道已开启</strong><p>1 台已配对设备</p></div><span><ShieldCheck size={22} aria-hidden="true" /></span></div>
    <div className={device.actionsRow}><button className={ui.secondary} onClick={demo}><ScanLine size={19} />添加电脑</button><button className={ui.secondary} onClick={demo}><KeyRound size={19} />无人值守</button></div>
    <div className={ui.sectionHead}>已配对设备<button className={ui.textButton} onClick={demo}>重新检查</button></div>
    <button className={device.peerSelect} onClick={demo}><RcDeviceIcon os="Windows 11" size={34} /><span><strong>LAPTOP-LZL</strong><RcDeviceMeta os="Windows 11" className={device.deviceType} /></span><ChevronRight size={18} /></button>
  </>;
  return <>
    <h2 className={ui.sectionHeading}>连接与记录</h2>
    <div className={ui.group}><button className="preview-setting" onClick={demo}><ShieldCheck size={22} /><span><strong>远程通道</strong><small>可连接电脑和传输文件；暂不支持被控</small></span></button><button className="preview-setting" onClick={demo}><Monitor size={22} /><span><strong>会话历史</strong><small>查看连接时间和会话时长</small></span><ChevronRight size={18} /></button></div>
    <h2 className={ui.sectionHeading}>使用偏好</h2><div className={ui.group}><button className="preview-setting" onClick={demo}><Settings2 size={22} /><span><strong>外观</strong><small>跟随系统</small></span><ChevronRight size={18} /></button></div>
  </>;
}

function Phone({ variant, page, landscape, small, largeText, long, changePage }: {
  variant: Variant; page: Page; landscape: boolean; small: boolean; largeText: boolean; long: boolean; changePage: (page: Page) => void;
}) {
  const [notice, setNotice] = useState(false);
  const Icon = icons[page];
  const [title, subtitle] = pages[page];
  const demo = () => setNotice(true);
  const action = page === "devices" ? <button type="button" className={ui.textButton} onClick={demo}><Plus size={20} aria-hidden="true" />添加</button> : undefined;
  const content = <>{notice && <MobileNotice tone="info" title="设计预览" detail="这里只演示页头样式，不发起连接或文件传输。" onDismiss={() => setNotice(false)} />}<MainContent page={page} demo={demo} long={long} /></>;
  return <article className="comparison" data-variant={variant}>
    <h2>{variants[variant][0]}</h2><p className="variant-description">{variants[variant][1]}</p>
    <div className="phone" data-layout={landscape ? "landscape" : "portrait"} data-small={small} data-large-text={largeText}>
      <div className="preview-status" aria-label="模拟系统状态栏"><span>13:35</span><span>5G · 86%</span></div>
      <div className="preview-scroll">
        {variant === "current" ? <div><header className="baseline-head"><h1 data-mobile-page-title>{title}</h1>{action}</header><p className="baseline-subtitle">{subtitle}</p>{content}</div> : <div>
          <header className="upgraded-header">
            {variant === "B" && <span className="page-symbol"><Icon size={22} aria-hidden="true" /></span>}
            <div className="header-copy"><h1>{title}</h1><p>{subtitle}</p></div>{action}
          </header>
          {content}
        </div>}
      </div>
      <nav className={`${nav.tabbar} preview-navigation`} aria-label={`${variants[variant][0]}页面导航`}>
        {(["devices", "files", "settings"] as Page[]).map(item => { const ItemIcon = icons[item]; return <button key={item} type="button" className={`${nav.tab} ${page === item ? `${nav.tabActive} preview-tab-active` : ""}`} aria-pressed={page === item} onClick={() => changePage(item)}><ItemIcon size={22} aria-hidden="true" /><span>{pages[item][0]}</span></button>; })}
      </nav>
    </div>
  </article>;
}

function App() {
  const [page, setPage] = useState<Page>("files");
  const [landscape, setLandscape] = useState(false);
  const [small, setSmall] = useState(false);
  const [largeText, setLargeText] = useState(false);
  const [long, setLong] = useState(false);
  return <main className="header-review" data-landscape={landscape}>
    <header className="review-heading"><h1>让页头融入页面，把空间留给内容。</h1><p>真机顶部白色直角块来自共用 MobilePage。两案沿用现有主题、文案和操作，只调整页头；文件页其余区域保持基线。</p></header>
    <div className="review-controls" aria-label="设计预览控制">
      <label>页面<select value={page} onChange={e => setPage(e.target.value as Page)}><option value="files">文件</option><option value="devices">设备</option><option value="settings">设置</option></select></label>
      <button aria-pressed={landscape} onClick={() => setLandscape(v => !v)}>{landscape ? "横屏" : "竖屏"}</button>
      <button aria-pressed={small} onClick={() => setSmall(v => !v)}>320px 小屏</button>
      <button aria-pressed={largeText} onClick={() => setLargeText(v => !v)}>130% 页头字体</button>
      <button aria-pressed={long} onClick={() => setLong(v => !v)}>长设备名</button>
      <a href="../.cache/mobile-file-header-before-2026-10-04.png" target="_blank" rel="noreferrer">查看本次真机截图</a>
    </div>
    <div className="comparison-grid">{(["current", "A", "B"] as Variant[]).map(variant => <Phone key={variant} {...{variant, page, landscape, small, largeText, long}} changePage={setPage} />)}</div>
    <p className="review-note">A 最轻，标题随正文滚动；B 方向感更强，固定工具头持续占用约 64px（横屏 48px）。确认后统一应用到设备、文件、设置；本页尚未修改正式 APP。</p>
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
