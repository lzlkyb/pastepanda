import { createRoot } from "react-dom/client";
import { useState } from "react";
import { FileDown, Monitor, MousePointer2, Keyboard, Ellipsis, X, ChevronDown } from "lucide-react";
import { RcDeviceIcon } from "../src/components/rc/RcDeviceIcon";
import "../src/styles/theme.css";
import "../src-mobile/styles/mobile-base.css";
import "./mobile-interaction-repair-2026-10-02.css";

function Preview() {
  const [receiving, setReceiving] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [screen, setScreen] = useState(false);
  return <main className="repair-preview">
    <header><h1>手机端交互修复</h1><p>拟实施的入口调整 · 示例数据 · 沿用 C 布局与 B 毛玻璃。可点击查看文件请求、取消准备、画面快捷操作。</p></header>
    <div className="repair-flows">
      <section><h2>会话内处理文件请求</h2><p>不结束远程控制，打开面板时暂停远程输入。</p>
        <div className="repair-phone repair-session">
          <div className="repair-head">工作电脑 <small>控制中</small></div>
          <div className="repair-remote"><Monitor size={64}/><strong>远程画面</strong><small>此处为示意，不连接电脑</small></div>
          <button className="repair-request" onClick={() => setReceiving(true)}><FileDown size={22}/><span><strong>1 个文件请求待确认</strong><small>工作电脑 · 产品说明.pdf</small></span><span>查看</span></button>
          <nav><button><MousePointer2/>触控板</button><button><Keyboard/>键盘</button><button onClick={() => setScreen(true)}><Monitor/>画面</button><button><Ellipsis/>更多</button></nav>
          {receiving && <div className="repair-scrim"><div className="repair-sheet"><span className="repair-grip"/><header><h3>文件请求</h3><button onClick={() => setReceiving(false)}><X size={18}/>关闭</button></header><strong>工作电脑想给你发送文件</strong><p>产品说明.pdf · 2.4 MB</p><p>等待你确认 · 还剩 42 秒（示例）</p><button className="repair-primary" onClick={() => setReceiving(false)}>接受并返回画面</button><button className="repair-secondary" onClick={() => setReceiving(false)}>拒绝</button><small>错误、接收位置加载状态也在本面板显示。</small></div></div>}
          {screen && <div className="repair-scrim"><div className="repair-sheet"><span className="repair-grip"/><header><h3>画面</h3><button onClick={() => setScreen(false)}><X size={18}/>关闭</button></header><button className="repair-secondary" onClick={() => setScreen(false)}>适应屏幕</button><button className="repair-secondary" onClick={() => setScreen(false)}>回到指针</button><p>画质：清晰 / 均衡 / 流畅</p></div></div>}
        </div>
      </section>
      <section><h2>准备文件可取消</h2><p>区分本机准备、对方确认、真正传输。</p>
        <div className="repair-phone"><div className="repair-head repair-title">文件</div><p>不接管画面，也能互传文件。</p><button className="repair-peer"><RcDeviceIcon os="windows" size={36}/><span><small>传输对象</small><strong>工作电脑</strong><small>电脑 · Windows</small></span><ChevronDown size={18}/></button><div className="repair-actions"><button className="repair-primary" disabled={!cancelled}>发文件到电脑</button><button className="repair-secondary">从电脑取文件</button></div><div className="repair-progress" role="status"><strong>{cancelled ? "已取消本批准备" : "正在准备文件 1 / 3"}</strong><p>{cancelled ? "后续文件不会继续提交。" : "演示视频.mp4 · 正在读取并写入本机暂存"}</p>{!cancelled && <><progress value="38" max="100"/><p>本文件 38% · 完成后等待电脑确认</p><button className="repair-secondary" onClick={() => setCancelled(true)}>取消本批准备</button></>}</div><h3>传输记录</h3><p>已提交的文件保留各自进度和取消入口。</p></div>
      </section>
      <section><h2>设备选择与管理</h2><p>各入口使用真实设备名称、类型和图标；解除配对放入设备管理。</p>
        <div className="repair-phone"><div className="repair-head repair-title">选择设备</div><p>为文件传输选择目标</p>{[["windows","工作电脑","电脑 · Windows"],["ipados","iPad Air","平板 · iPadOS"],["android","小米 14","手机 · Android"]].map(([os,name,type]) => <button className="repair-peer" key={name}><RcDeviceIcon os={os} size={36}/><span><strong>{name}</strong><small>{type}</small></span></button>)}<hr/><h3>工作电脑</h3><button className="repair-primary">远程控制</button><button className="repair-secondary">只看画面</button><button className="repair-secondary">传文件</button><button className="repair-secondary">无人值守接入</button><button className="repair-text">管理设备 → 解除配对</button></div>
      </section>
    </div>
    <footer>原有按钮加载反馈、密码校验提示、配对文案和指南纠错不改变布局，直接修复。此页只确认新增会话入口、准备取消和管理层级。</footer>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Preview/>);
