import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowLeft, ChevronRight, CircleAlert, Clock3, Folder, Hand, Keyboard, Monitor, MousePointer2, Plus, Settings2, ShieldCheck, X } from "lucide-react";
import { MobilePage } from "../src-mobile/ui/MobilePage";
import { POINTER_MODES, type PointerMode } from "../src-mobile/session/pointerModes";
import ui from "../src-mobile/ui/MobileUi.module.css";
import "../src/styles/theme.css";
import "../src-mobile/styles/mobile-base.css";
import "./mobile-content-priority-2026-10-04.css";

type Scene = "remote" | "devices" | "files" | "settings";
type FrameState = "ready" | "waiting" | "stale" | "error";
const titles = { devices: "设备", files: "文件", settings: "设置", remote: "远程画面" };
const sizes = { small: "小屏 320 × 640", normal: "标准 390 × 844", large: "大屏 430 × 932" };

function App() {
  const [variant, setVariant] = useState("B");
  const [scene, setScene] = useState<Scene>("remote");
  const [size, setSize] = useState("normal");
  const [landscape, setLandscape] = useState(true);
  const [frameState, setFrameState] = useState<FrameState>("ready");
  const [tools, setTools] = useState(false);
  const [mouse, setMouse] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const [largeText, setLargeText] = useState(false);
  const [safe, setSafe] = useState(true);
  const [panel, setPanel] = useState<string | null>(null);
  const [mode, setMode] = useState<PointerMode>("trackpad");
  const [dragging, setDragging] = useState(false);
  const [scrolling, setScrolling] = useState(false);
  const [feedback, setFeedback] = useState("");
  const changeScene = (next: Scene) => { setScene(next); setPanel(null); setKeyboard(false); setFeedback(""); };
  const action = (text: string) => setFeedback(`设计演示：${text}`);
  const navItems = [["devices", Monitor], ["files", Folder], ["settings", Settings2]] as const;
  const controlButtons = <>
    <button onClick={() => setPanel("操作方式")}><MousePointer2 size={20} /><span>{POINTER_MODES[mode].label}</span></button>
    <button disabled={frameState !== "ready"} onClick={() => setKeyboard(v => !v)} aria-pressed={keyboard}><Keyboard size={20} /><span>键盘</span></button>
    <button onClick={() => setPanel("画面")}><Monitor size={20} /><span>画面</span></button>
    <button onClick={() => setPanel("更多")}><Settings2 size={20} /><span>更多</span></button>
  </>;
  const mouseButtons = <>
    <button disabled={dragging} onClick={() => action("左键点击")} >左键</button>
    <button disabled={dragging} onClick={() => action("右键点击")} >右键</button>
    <button aria-pressed={dragging} onClick={() => setDragging(v => !v)}>{dragging ? "释放" : "拖拽"}</button>
    <button aria-pressed={scrolling} onClick={() => setScrolling(v => !v)}>滚动</button>
  </>;
  return <div className="review">
    <header className="review-heading"><div><h1>让画面成为主角</h1><p>手机端响应式调整稿 · 2026-10-04 · 等待确认</p></div>
      <div className="variants" aria-label="布局方案">{["A", "B"].map(v => <button key={v} aria-pressed={variant === v} onClick={() => { setVariant(v); setTools(false); }}>{v} {v === "A" ? "紧凑工具栏" : "画面优先 · 推荐"}</button>)}</div>
    </header>
    <section className="review-controls" aria-label="预览设置">
      <label>页面<select value={scene} onChange={e => changeScene(e.target.value as Scene)}>{Object.entries(titles).map(([k,v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label>屏幕<select value={size} onChange={e => setSize(e.target.value)}>{Object.entries(sizes).map(([k,v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <button aria-pressed={landscape} onClick={() => setLandscape(v => !v)}>{landscape ? "横屏 → 竖屏" : "竖屏 → 横屏"}</button>
      <label>画面状态<select value={frameState} onChange={e => { setFrameState(e.target.value as FrameState); setKeyboard(false); }}>{[["ready","正常画面"],["waiting","等待首帧"],["stale","连接恢复中"],["error","无法接收画面"]].map(([k,v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <button aria-pressed={largeText} onClick={() => setLargeText(v => !v)}>大字 130%</button>
      <button aria-pressed={safe} onClick={() => setSafe(v => !v)}>安全区</button>
      <button aria-pressed={keyboard} onClick={() => setKeyboard(v => !v)}>键盘遮挡</button>
    </section>
    <div className="preview-stage"><div className="device" data-size={size} data-landscape={landscape} data-large-text={largeText} data-safe={safe}>
      <div className="screen" data-variant={variant} data-keyboard={keyboard} data-scene={scene}>
        {scene === "remote" ? <div className="remote" inert={!!panel}>
          {(variant === "A" || !landscape) && <header className="remote-header"><button aria-label="返回设备" onClick={() => setPanel("断开连接")}><ArrowLeft size={20} /></button><strong>LAPTOP-LZL</strong><button onClick={() => setPanel("连接详情")}>延时 {frameState === "ready" ? "8 ms" : "测量中"}</button></header>}
          <div className="remote-workspace">
            <div className="remote-view">
              {frameState !== "waiting" && <div className="desktop-picture"><img src="./mobile-content-priority-reference-2026-10-04.png" alt="用户提供的电脑远程画面，用于对比布局" /></div>}
              {frameState !== "ready" && <div className={`frame-message ${frameState === "waiting" ? "first-frame" : ""}`} role={frameState === "error" ? "alert" : "status"}>
                {frameState === "error" ? <CircleAlert size={24} /> : <Clock3 size={24} />}
                <strong>{frameState === "waiting" ? "电脑正在准备画面…" : frameState === "stale" ? "正在恢复画面…" : "暂时无法接收画面"}</strong>
                <p>{frameState === "waiting" ? "收到画面后自动显示。" : "输入已暂停，恢复后可继续操作。"}</p>
                <button onClick={() => setPanel("断开连接")}>{frameState === "waiting" ? "取消连接" : "返回设备"}</button>
              </div>}
              {frameState === "ready" && (dragging || scrolling) && <div className="mode-status" role="status">{dragging ? "拖拽中 · 点释放结束" : "滚动中 · 点滚动退出"}</div>}
              {frameState === "ready" && mode === "floating" && <button className="floating-mouse" onClick={() => action("浮动鼠标点击")}><MousePointer2 size={24} /><span>鼠标</span></button>}
            </div>
            {landscape && variant === "B" && <aside className="remote-rail" aria-label="会话工具">
              <button onClick={() => setTools(v => !v)} aria-expanded={tools}>{tools ? <X size={18} /> : <Settings2 size={18} />}<span>{tools ? "收起" : "工具"}</span></button>
              <button onClick={() => setPanel("连接详情")} className="latency"><span>延时</span><strong>{frameState === "ready" ? "8 ms" : "测量中"}</strong></button>
              {tools && controlButtons}
              {!tools && frameState === "ready" && <button aria-pressed={mouse} onClick={() => setMouse(v => !v)}><MousePointer2 size={18} /><span>鼠标</span></button>}
              {!tools && frameState === "ready" && mouse && <div className="rail-mouse">{mouseButtons}</div>}
            </aside>}
            {frameState === "ready" && mode === "pad" && <div className="independent-pad"><Hand size={24} /><span>独立触控板</span><small>划动移动指针</small><button onClick={() => setMode("trackpad")}>收起触控板</button></div>}
          </div>
          {frameState === "ready" && mouse && (variant === "A" || !landscape) && <section className="compact-mouse" aria-label="鼠标辅助">{mouseButtons}</section>}
          {(variant === "A" || !landscape) && <nav className="remote-toolbar" aria-label="会话工具">{controlButtons}</nav>}
          {feedback && <button className="demo-feedback" onClick={() => setFeedback("")} role="status">{feedback} · 关闭</button>}
        </div> : <div className="home" inert={!!panel}>
          <div className="home-scroll"><MobilePage title={titles[scene]} subtitle={scene === "devices" ? "连接电脑，让工作随身。" : scene === "files" ? "不接管画面，也能互传文件。" : "按自己的习惯使用 PastePanda"}
            action={scene === "devices" ? <button className={ui.textButton} onClick={() => setPanel("添加电脑")}><Plus size={20} />添加</button> : undefined}>
            {scene === "devices" && <>
              <div className="channel-line"><ShieldCheck size={18} /><span>远程通道已开启 · 1 台已配对</span></div>
              <div className="home-actions"><button onClick={() => setPanel("添加电脑")}>添加电脑</button><button onClick={() => setPanel("无人值守")}>无人值守</button></div>
              <div className="section-label"><span>已配对设备</span><button onClick={() => action("重新检查设备")}>重新检查</button></div>
              <button className="device-row" onClick={() => changeScene("remote")}><Monitor size={32} /><span><strong>LAPTOP-LZL</strong><small>Windows · 可以连接</small></span><ChevronRight size={20} /></button>
              <p className="helper">点设备选择远程控制、观看或传文件。</p>
            </>}
            {scene === "files" && <>
              <div className="file-layout"><div><button className="device-row" onClick={() => setPanel("选择传输对象")}><Monitor size={28} /><span><small>传输对象</small><strong>LAPTOP-LZL</strong></span><ChevronRight size={20} /></button>
                <div className="home-actions"><button onClick={() => action("发文件到电脑")}>发文件到电脑</button><button onClick={() => action("从电脑取文件")}>从电脑取文件</button></div><button className="location" onClick={() => setPanel("接收位置")}>查看接收位置 <ChevronRight size={16} /></button></div>
                <div><h2>文件任务</h2><div className="empty-tasks"><Folder size={24} /><strong>还没有传输任务</strong><p>发送或取回文件后，在这里查看进度。</p></div></div></div>
            </>}
            {scene === "settings" && <div className="settings-layout">{[["连接与记录",["远程通道","会话历史"]],["使用偏好",["外观","手势使用指南","触摸演示"]]].map(([heading,items]) => <section key={heading as string}><h2>{heading}</h2><div className="setting-group">{(items as string[]).map(item => <button key={item} onClick={() => setPanel(item)}>{item}<ChevronRight size={18} /></button>)}</div></section>)}</div>}
          </MobilePage></div>
          <nav className="home-nav" aria-label="主导航">{navItems.map(([name,Icon]) => <button key={name} aria-current={scene === name ? "page" : undefined} onClick={() => changeScene(name)}><Icon size={20} /><span>{titles[name]}</span></button>)}</nav>
          {feedback && <button className="demo-feedback" role="status" onClick={() => setFeedback("")}>{feedback} · 关闭</button>}
        </div>}
        {keyboard && <div className="keyboard-demo"><div><span>键盘演示 · 真实界面跟随可视高度</span><button onClick={() => setKeyboard(false)}>收起</button></div><input aria-label="键盘输入演示" placeholder="输入文字…" />{["Q W E R T Y U I O P","A S D F G H J K L","Z X C V B N M"].map(row => <div className="key-row" key={row}>{row.split(" ").map(key => <span key={key}>{key}</span>)}</div>)}</div>}
        {panel && <div className="sheet-overlay"><section className="preview-sheet" role="dialog" aria-modal="true" aria-label={panel}><header><h2>{panel}</h2><button onClick={() => setPanel(null)}><X size={18} />关闭</button></header><div className="sheet-scroll">
          {panel === "操作方式" ? <>{Object.entries(POINTER_MODES).map(([key,value]) => <button className="choice" key={key} aria-pressed={mode === key} onClick={() => { setMode(key as PointerMode); setPanel(null); }}><span><strong>{value.label}</strong><small>{value.description}</small></span>{mode === key ? "已选" : "选择"}</button>)}<button className="choice" onClick={() => { setMouse(v => !v); setPanel(null); }}>鼠标辅助 {mouse ? "关闭" : "开启"}</button></>
          : panel === "连接详情" ? <><p>以下为设计示例数据。</p><dl><div><dt>延时</dt><dd>8 ms</dd></div><div><dt>连接方式</dt><dd>局域网直连</dd></div><div><dt>画面</dt><dd>1920 × 1080</dd></div></dl><button className="choice" onClick={() => setPanel("画面")}>调整画面与画质</button></>
          : panel === "断开连接" ? <><p>将结束这次远程会话，电脑上的工作会继续保留。</p><button className="choice" onClick={() => changeScene("devices")}>确认断开</button><button className="choice" onClick={() => setPanel(null)}>继续连接</button></>
          : panel === "画面" ? <><button className="choice" onClick={() => setPanel(null)}>适应屏幕</button><button className="choice" onClick={() => { setLandscape(v => !v); setPanel(null); }}>切换到{landscape ? "竖屏" : "横屏"}</button><button className="choice" onClick={() => action("回到指针")}>回到指针</button><h2>画质</h2><div className="home-actions">{["流畅","均衡","清晰"].map(v => <button key={v} onClick={() => action(`切换到${v}`)}>{v}</button>)}</div></>
          : panel === "更多" ? <>{["连接详情","操作方式","剪贴板","断开连接"].map(v => <button className="choice" key={v} onClick={() => setPanel(v)}>{v}<ChevronRight size={18} /></button>)}</>
          : <><p>这里演示统一弹层的响应式尺寸与滚动，不执行真实电脑操作。</p><button className="choice" onClick={() => setPanel(null)}>完成</button></>}
        </div></section></div>}
      </div>
    </div></div>
    <footer className="review-notes"><div><strong>{variant === "B" ? "B · 画面优先" : "A · 紧凑工具栏"}</strong><p>{variant === "B" ? "横屏不留整行工具空白。窄侧栏独立留位，工具不盖住画面；按需展开辅助操作。" : "工具常驻，入口容易找到；顶部与底部仍会占用一部分画面高度。"}</p></div><div><strong>统一适配标准</strong><p>标题、导航、状态、弹层一起适配。画面保持比例，黑边只来自宽高比；不拉伸、不裁掉电脑边缘。</p></div><div><strong>预览范围</strong><p>可切换三种屏幕、四个页面及四种画面状态。延时、连接和操作为演示；真机系统栏、键盘、触控仍需验收。</p></div></footer>
  </div>;
}
createRoot(document.getElementById("root")!).render(<App />);
