import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";
import { FolderOpen, Monitor, Settings2, ShieldCheck, ChevronRight, FolderDown } from "lucide-react";
import { RcDeviceIcon } from "../src/components/rc/RcDeviceIcon";
import { MobileNotice } from "../src-mobile/ui/MobileNotice";
import app from "../src-mobile/App.module.css";
import ui from "../src-mobile/ui/MobileUi.module.css";
import "../src/styles/theme.css";
import "../src-mobile/styles/mobile-base.css";
import "./mobile-tabs-permissions-2026-10-02.css";

const tabs = [{ label: "设备", Icon: Monitor }, { label: "文件", Icon: FolderOpen }, { label: "设置", Icon: Settings2 }];
function Preview() {
  const [tab, setTab] = useState(0), [drag, setDrag] = useState(0), [kind, setKind] = useState("directory");
  const pane = useRef<HTMLElement>(null), start = useRef<{ x: number; y: number; axis: string } | null>(null);
  const select = (next: number) => { setTab(Math.max(0, Math.min(2, next))); setDrag(0); };
  const permission = kind === "directory" ? "手机无法在当前接收位置保存文件。请点「重置接收位置」改用应用默认目录，再重新取文件；无需开启相机权限。"
    : kind === "remote" ? "电脑没有同意发送文件。请在电脑端 PastePanda 的文件请求中确认并选择文件，然后在手机上重新取文件。"
    : "应用内部授权失败，取文件请求未能发出。请重新打开 PastePanda 后重试；若仍失败，请记录此提示以便排查，无需调整手机权限。";
  return <main className="tabs-preview">
    <header><h1>左右滑动，切换页签</h1><p>沿用现有 C 布局与 B 毛玻璃。滑动与底部点击使用同一顺序；示例数据，不连接设备。</p></header>
    <div className="tabs-preview-layout">
      <section className="tabs-phone">
        <div className={app.root}>
          <main ref={pane} className={`${app.pane} tabs-demo-pane`}
            onPointerDown={(e) => { if (e.pointerType === "mouse" || (e.target as HTMLElement).closest("button,input,select")) return; start.current = { x: e.clientX, y: e.clientY, axis: "" }; }}
            onPointerMove={(e) => { const s = start.current; if (!s) return; const x = e.clientX - s.x, y = e.clientY - s.y; if (!s.axis && Math.max(Math.abs(x), Math.abs(y)) > 12) s.axis = Math.abs(x) > Math.abs(y) * 1.3 ? "x" : "y"; if (s.axis !== "x") return; const edge = (tab === 0 && x > 0) || (tab === 2 && x < 0); const d = Math.max(-64, Math.min(64, x * (edge ? 0.16 : 0.35))); pane.current?.style.setProperty("--demo-drag", `${d}px`); setDrag(edge ? 0 : x); }}
            onPointerUp={() => { if (Math.abs(drag) >= 60) select(tab + (drag < 0 ? 1 : -1)); setDrag(0); start.current = null; pane.current?.style.removeProperty("--demo-drag"); }}
            onPointerCancel={() => { setDrag(0); start.current = null; pane.current?.style.removeProperty("--demo-drag"); }}>
            <header className={ui.pageHead}><h1>{tabs[tab].label}</h1></header>
            <p className={ui.subtitle}>{["连接电脑，让工作随身。", "不接管画面，也能互传文件。", "按自己的习惯使用 PastePanda"][tab]}</p>
            {tab === 0 && <><div className="tabs-channel"><ShieldCheck/><span><strong>远程通道已开启</strong><small>1 台已配对设备</small></span></div><div className={ui.group}><button className="tabs-device"><RcDeviceIcon os="windows" size={40}/><span><strong>工作电脑</strong><small>电脑 · Windows · 刚刚可连接</small></span><ChevronRight size={18}/></button></div><p className={ui.hint}>点设备选择远程控制、观看或传文件。</p></>}
            {tab === 1 && <><button className="tabs-device"><RcDeviceIcon os="windows" size={36}/><span><small>传输对象</small><strong>工作电脑</strong></span></button><div className="tabs-file-actions"><button className={ui.primary}>发文件到电脑</button><button className={ui.secondary}><FolderDown size={20}/>从电脑取文件</button></div><p className={ui.hint}>电脑端需要确认并选择文件。</p><MobileNotice error>{permission}</MobileNotice>{kind === "directory" && <button className={ui.secondary} onClick={() => setKind("resolved")}>重置接收位置</button>}{kind === "resolved" && <MobileNotice>示例：已恢复默认接收位置，请重新取文件。</MobileNotice>}<h2 className={ui.sectionHeading}>传输记录</h2><p className={ui.hint}>还没有传输记录。</p></>}
            {tab === 2 && <><h2 className={ui.sectionHeading}>连接与记录</h2><div className={ui.group}><div className="tabs-device"><ShieldCheck/><span><strong>远程通道</strong><small>允许发起和接收连接</small></span></div></div><h2 className={ui.sectionHeading}>使用偏好</h2><div className={ui.group}>{["外观", "手势使用指南", "触摸演示"].map(t => <button key={t} className="tabs-device"><span><strong>{t}</strong></span><ChevronRight size={18}/></button>)}</div></>}
          </main>
          {Math.abs(drag) > 12 && <div className="tabs-drag-hint" role="status">{Math.abs(drag) >= 60 ? "松手切换到" : "继续滑动到"}{tabs[Math.max(0, Math.min(2, tab + (drag < 0 ? 1 : -1)))].label}</div>}
          <nav className={app.tabbar} aria-label="主要导航">{tabs.map(({label,Icon}, i) => <button key={label} className={`${app.tab} ${i===tab ? `${app.tabActive} tabs-demo-selected` : ""}`} aria-current={i===tab ? "page" : undefined} onClick={() => select(i)}><Icon size={23}/><span>{label}</span></button>)}</nav>
        </div>
      </section>
      <section className="tabs-preview-notes"><h2>滑动规则</h2><p>左滑进入下一页，右滑回到上一页；首页与末页不循环。未达到距离时回弹。底部页签继续支持点击。</p><p>保留各页滚动位置和文件准备状态。纵向滚动、输入框、滑块、系统边缘手势、弹窗与远控画面不会切页。</p><h2>取文件失败：告诉用户下一步</h2><p>点击下面的情况，再点「文件」查看提示。目录失败提供「重置接收位置」；电脑拒绝明确指向电脑确认；内部授权错误不让用户乱改系统权限。</p><div className="tabs-error-options">{[["directory", "手机接收位置不可用"], ["remote", "电脑拒绝请求"], ["internal", "应用内部授权失败"]].map(([id,label]) => <button key={id} className={kind===id ? ui.primary : ui.secondary} onClick={() => { setKind(id); select(1); }}>{label}</button>)}</div><p>正式实施沿用现有弹簧，支持减少动态效果。此稿展示交互，不证明真机权限问题已消失。</p></section>
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Preview/>);
