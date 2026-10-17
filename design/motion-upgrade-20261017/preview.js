/* Review-only prototype. All content, task results and waits are illustrative. No Tauri IPC. */
(() => {
  "use strict";
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const paths = {
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M5.5 8h1M5.5 12h1"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
    settings: '<path d="m9.5 3-.7 2.5-2 .9-2.3-.7L2 10l1.8 1.8v2.3L2 16l2.5 4.2 2.4-.7 2 .9L9.5 23h5l.7-2.6 2-.9 2.3.7L22 16l-1.8-1.9v-2.3L22 10l-2.5-4.3-2.3.7-2-.9L14.5 3Z" transform="translate(1 -1) scale(.9)"/><circle cx="12" cy="11.5" r="3"/>',
    minus: '<path d="M5 12h14"/>',
    hide: '<path d="M3 3 21 21M9 5a11 11 0 0 1 12 7 15 15 0 0 1-3 4M6 6a16 16 0 0 0-3 6c4 7 11 9 16 5"/><path d="M10 10a3 3 0 0 0 4 4"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    pin: '<path d="M8 3h8l-1 6 4 4v2H5v-2l4-4-1-6ZM12 15v6"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    file: '<path d="M14 3H5v18h14V8l-5-5Z"/><path d="M14 3v6h5M8 13h8M8 17h6"/>',
    folder: '<path d="M3 6h7l2 3h9v11H3V6Z"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/>',
    link: '<path d="m9 15 6-6M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(2 0) scale(.85)"/>',
    code: '<path d="m8 6-6 6 6 6M16 6l6 6-6 6M14 3l-4 18"/>',
    text: '<path d="M4 5h16M12 5v15M8 20h8"/>',
    star: '<path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.3L12 17.5l-5.7 3 1.1-6.3L2.8 9.7l6.4-.9L12 3Z"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
    plus: '<path d="M12 4v16M4 12h16"/>',
    arrow: '<path d="m12 5-7 7 7 7M5 12h15"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
    video: '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    play: '<path d="m7 4 14 8-14 8V4Z"/>',
    stop: '<rect x="5" y="5" width="14" height="14" rx="1"/>',
    warning: '<path d="m12 3 10 18H2L12 3ZM12 9v5M12 17h.01"/>',
    undo: '<path d="m8 5-5 5 5 5M3 10h10a7 7 0 0 1 7 7"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
    cloud: '<path d="M7 18a5 5 0 1 1 0-10 6 6 0 0 1 11-1 5.5 5.5 0 0 1 0 11ZM9 12l3-3 3 3M12 9v10"/>',
    crop: '<path d="M6 2v16h16M2 6h16v16M18 6l3-3M3 21l3-3"/>',
    keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M8 16h8"/>',
  };
  const icon = (name, extra = "") => `<svg class="icon ${extra}" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.file}</svg>`;
  const esc = (value) => String(value).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
  const windowEl = $("#appWindow");
  const workspace = $("#workspace");
  const osReduced = matchMedia("(prefers-reduced-motion: reduce)");
  const state = { view:"record", previousView:"record", direction:"b", before:false, sidebar:true, filter:"all", query:"", category:"全部", group:"全部", note:0, draft:"", noteError:false, motion:true, recPaused:false, recTiny:false, recMore:false, recSaved:false, connection:"idle", settingsTab:"外观", theme:"ocean", busy:false };
  let nextId = 10;
  let queryEpoch = 0;
  let navEpoch = 0;
  let sequenceEpoch = 0;
  let connectionEpoch = 0;
  let undoAction = null;
  let lastMenuFocus = null;
  let lastDialogFocus = null;
  const animations = new Set();
  const jobs = new Map();
  let nextJob = 0;
  function schedule(fn, ms) {
    const id = ++nextJob;
    const job = { remaining:ms, started:performance.now(), handle:null, held:false, fn };
    const arm = () => { job.started = performance.now(); job.handle = setTimeout(() => { jobs.delete(id); fn(); }, job.remaining); };
    job.arm = arm;
    jobs.set(id, job);
    if (!document.hidden) arm();
    return id;
  }
  function cancelJob(id) { const job=jobs.get(id); if(job) { clearTimeout(job.handle); jobs.delete(id); } }
  const reduced = () => $("#reduced").checked || !state.motion;
  function animate(el, keyframes, duration=200, ease="cubic-bezier(.2,0,0,1)") {
    if (!el || reduced() || document.hidden) return null;
    const animation = el.animate(keyframes, { duration, easing:ease });
    animations.add(animation);
    animation.finished.catch(() => {}).finally(() => animations.delete(animation));
    return animation;
  }
  function report(message, duration=200) {
    $("#interactionText").textContent = message;
    $("#durationReadout").textContent = reduced() ? "无空间运动" : `${duration} ms`;
  }
  function status(message) { $("#statusText").textContent=message; }
  function syncReduced() {
    document.documentElement.dataset.reduced = String(reduced());
    if(reduced()) animations.forEach(a=>a.cancel());
  }
  function enter(el=workspace) {
    const distance = state.before ? 8 : state.direction === "a" ? 0 : state.direction === "c" ? 8 : 4;
    animate(el, [{opacity:.7, transform:`translateY(${distance}px)`},{opacity:1, transform:"translateY(0)"}], state.before ? 180 : 200, "cubic-bezier(.05,.7,.1,1)");
  }
  function flip(container, change) {
    const before = new Map($$("[data-row]",container).slice(0,8).map(el=>[el.dataset.row,el.getBoundingClientRect()]));
    change();
    $$("[data-row]",container).slice(0,8).forEach(el=>{
      const previous=before.get(el.dataset.row);
      if(!previous) { animate(el,[{opacity:0, transform:"translateY(-6px)"},{opacity:1,transform:"translateY(0)"}],200); return; }
      const current=el.getBoundingClientRect();
      const dy=previous.top-current.top;
      if(Math.abs(dy)>1 && state.direction!=="a") animate(el,[{transform:`translateY(${dy}px)`},{transform:"translateY(0)"}],200);
    });
  }
  const clips = [
    {id:1,kind:"text",icon:"text",title:"周一例会：把今天的想法留住",meta:"记事本 · 2 分钟前",pinned:false},
    {id:2,kind:"text",icon:"link",title:"Apple Human Interface Guidelines",meta:"Microsoft Edge · 8 分钟前",pinned:true},
    {id:3,kind:"text",icon:"code",title:"SELECT name, created_at FROM notes;",meta:"Visual Studio Code · 12 分钟前",pinned:false},
    {id:4,kind:"image",icon:"image",title:"界面反馈截图 · 1440 × 900",meta:"截图 · 18 分钟前",pinned:false},
    {id:5,kind:"file",icon:"file",title:"交互改进计划.md",meta:"文件资源管理器 · 28 分钟前",pinned:false},
    {id:6,kind:"text",icon:"text",title:"复制，整理，再回到眼前的工作。",meta:"记事本 · 35 分钟前",pinned:false},
  ];
  const notes = [
    {title:"办公演示准备清单",date:"今天 10:24",lead:"把准备工作放在一处，演示时就能专注内容。",heading:"开始前",items:["整理要演示的窗口与文件。","检查录制范围和声音来源。","结束后预览成片，核对文件位置。"]},
    {title:"让工具顺手的几个细节",date:"昨天 16:40",lead:"高频操作应当明确，完成以后也应该让人知道发生了什么。",heading:"保留连续感",items:["内容在原处，反馈靠近动作。","错误给出恢复入口。","下一步不必等动画结束。"]},
    {title:"问题反馈模板",date:"昨天 09:15",lead:"把问题描述清楚，能让协作少一次来回。",heading:"需要记录",items:["操作步骤与预期结果。","实际表现和出现频率。","截图、短录屏与系统环境。"]},
  ];
  function sideNav(knowledge=false) {
    const rows=knowledge ? [["folder","全部笔记","24"],["star","置顶","3"],["folder","工作记录","12"],["folder","产品想法","7"],["folder","未分组","5"]] : [["grid","全部","128"],["star","收藏","16"],["folder","未分组","28"],["crop","截图","8"]];
    return `<aside class="sidebar ${knowledge ? "knowledge-sidebar" : ""} ${state.sidebar?"":"collapsed"}" ${state.sidebar?"":"inert"} aria-label="${knowledge ? "笔记文件夹" : "记录分组"}"><div class="side-heading">${knowledge?"我的知识库":"分组"}</div>${rows.map(([i,label,count],n)=>`<button class="nav-row ${state.group===label||knowledge&&n===0?"active":""}" data-${knowledge?"folder":"group"}="${label}">${icon(i)}${label}<small>${count}</small></button>`).join("")}<div class="side-separator"></div><button class="nav-row" data-action="new-group">${icon("plus")}${knowledge?"新建文件夹":"新建分组"}</button></aside>`;
  }
  function cardMarkup(item) {
    return `<article class="clip" data-row="${item.id}" tabindex="0" aria-label="${esc(item.title)}"><span class="clip-icon">${icon(item.icon)}</span><div class="clip-main"><div class="clip-title"><span>${esc(item.title)}</span>${item.pinned?icon("pin"):""}</div><div class="clip-meta">${esc(item.meta)}</div></div><div class="clip-actions"><button class="icon-button pin-button ${item.pinned?"is-pinned":""}" data-pin="${item.id}" aria-label="${item.pinned?"取消收藏":"收藏"}" title="${item.pinned?"取消收藏":"收藏"}">${icon("star")}</button><button class="button copy-button" data-copy="${item.id}">${icon("copy")}<span>复制</span></button><button class="icon-button" data-menu="${item.id}" aria-label="更多操作" title="更多操作">${icon("more")}</button></div></article>`;
  }
  function filteredClips() {
    return clips.filter(c=>(state.filter==="all"||state.filter==="pinned"&&c.pinned||c.kind===state.filter)&&(state.group!=="收藏"||c.pinned)&&(state.group!=="截图"||c.kind==="image")&&c.title.toLowerCase().includes(state.query.toLowerCase()));
  }
  function renderList() {
    const target=$("#clipList"); if(!target) return;
    const list=filteredClips();
    target.innerHTML=list.length ? list.map(cardMarkup).join("") : `<div class="empty-state">${icon("search")}<h3>没有匹配的记录</h3><p>换个关键词，或清除当前筛选。</p><button class="button" data-action="clear-filter">清除筛选</button></div>`;
    $("#resultCount").textContent=`${list.length} 条示例记录`;
  }
  function renderRecord() {
    workspace.innerHTML=`<div class="search-toolbar"><label class="search-field">${icon("search")}<input id="recordSearch" aria-label="搜索剪贴板内容" placeholder="搜索剪贴板内容" value="${esc(state.query)}"><kbd>Ctrl F</kbd></label><div class="filter-row"><div class="filter-tabs" aria-label="内容类型">${[["all","全部"],["text","文本"],["image","图片"],["file","文件"],["pinned","收藏"]].map(([key,label])=>`<button data-filter="${key}" class="${state.filter===key?"active":""}" aria-pressed="${state.filter===key}">${label}</button>`).join("")}</div><div class="filters-right"><select id="timeFilter" aria-label="时间筛选"><option>全部时间</option><option>今天</option></select><select id="sourceFilter" aria-label="来源筛选"><option>全部来源</option><option>记事本</option></select></div></div></div><div class="workspace-main">${sideNav()}<section class="list-pane" aria-label="剪贴板记录"><div class="section-caption">今天<span class="tag" id="resultCount"></span></div><div id="queryFeedback" aria-live="polite"></div><div class="clip-list" id="clipList"></div></section></div>`;
    renderList();
  }
  const tools=[
    ["copy","依次粘贴","按顺序逐条粘贴文本","Ctrl Alt Q","内容"],
    ["file","片段库","常用文本收藏，一键粘贴","","内容"],
    ["video","屏幕录制","录全屏或框选区域，存为高清 MP4","Ctrl Alt R","捕获"],
    ["monitor","远程电脑","查看或操作已配对的另一台电脑","","网络"],
    ["code","编码转换","批量转换文本文件编码，自动备份","","文本处理"],
    ["text","文本对比","自由对比两段文本","","文本处理"],
    ["grid","JSON 工具","校验、格式化或压缩 JSON","","文本处理"],
    ["link","内容提取","批量提取链接、邮箱、电话","","内容"],
  ];
  function renderToolGrid() {
    const q=$("#toolSearch")?.value.toLowerCase()||"";
    const matches=tools.filter(t=>(state.category==="全部"||t[4]===state.category)&&(t[1]+t[2]).toLowerCase().includes(q));
    $("#toolGrid").innerHTML=matches.length?matches.map(([i,name,description,key])=>`<button class="tool" data-tool="${name}"><span class="tool-tile">${icon(i)}</span><div><strong>${name}</strong><p>${description}</p>${key?`<kbd>${key}</kbd>`:""}</div>${icon("chevron")}</button>`).join(""):`<div class="empty-state"><h3>没有找到工具</h3><p>试试更短的关键词。</p></div>`;
  }
  function renderTools() {
    workspace.innerHTML=`<div class="search-toolbar"><label class="search-field">${icon("search")}<input id="toolSearch" placeholder="筛选工具…" aria-label="筛选工具"><kbd>Ctrl F</kbd></label><div class="filter-tabs">${["全部","内容","文本处理","捕获","网络"].map(c=>`<button data-category="${c}" class="${state.category===c?"active":""}" aria-pressed="${state.category===c}">${c}</button>`).join("")}</div></div><div class="tool-content"><h3 class="tools-group-title">常用工具 <span class="tag">入口保留</span></h3><div class="tool-grid" id="toolGrid"></div><h3 class="tools-group-title">最近录制</h3><div class="recent-line">${icon("video")}<span>办公演示.mp4 <small>· 00:37 · 示例</small></span><button class="button" data-action="record-preview">预览与裁剪</button></div></div>`;
    renderToolGrid();
  }
  function noteContent() {
    const n=notes[state.note];
    return `<div class="note-meta"><span>${n?"工作记录":"新笔记"} · 示例内容</span><span id="noteSaveState" class="save-state">${icon("check")} 已保存</span></div>${n?`<h2>${n.title}</h2><p>${n.lead}</p><h3>${n.heading}</h3><ul>${n.items.map(i=>`<li>${i}</li>`).join("")}</ul><h3>随手补充</h3>`:`<h2>新笔记</h2><p>内容变了，保存状态在同一位置跟进。</p>`}<textarea id="noteEditor" aria-label="笔记内容（仅演示）" placeholder="在这里输入，体验保存反馈…">${esc(state.draft)}</textarea><div id="noteSaveError"></div>`;
  }
  function renderKnowledge() {
    workspace.innerHTML=`<div class="search-toolbar"><div class="filter-row"><span class="section-caption">全部笔记 <span class="tag">24</span></span><button class="button primary" style="margin-left:auto" data-action="new-note">${icon("plus")}新建</button></div><label class="search-field">${icon("search")}<input id="noteSearch" aria-label="搜索笔记" placeholder="搜索笔记…"><kbd>Ctrl F</kbd></label></div><div class="workspace-main">${sideNav(true)}<nav class="knowledge-list" aria-label="笔记列表">${notes.map((n,i)=>`<button class="note-row ${state.note===i?"active":""}" data-note="${i}">${icon("file")}<div><strong>${n.title}</strong><p>${n.date}</p></div></button>`).join("")}</nav><section class="note-detail" id="noteDetail" aria-label="笔记详情">${noteContent()}</section></div>`;
  }
  const themeNames={ocean:"月白","ocean-dark":"深海",midnight:"午夜",forest:"森林",blossom:"美乐蒂",dawn:"晨曦"};
  function renderSettings() {
    const isAppearance=state.settingsTab==="外观";
    workspace.innerHTML=`<div class="settings-head"><button class="button" data-action="back">${icon("arrow")}返回</button><h2>设置</h2><label class="search-field">${icon("search")}<input id="settingSearch" placeholder="搜索设置…" aria-label="搜索设置"></label></div><div class="workspace-main"><nav class="settings-nav" aria-label="设置分类">${[["settings","通用"],["grid","外观"],["monitor","窗口与编辑器"],["keyboard","快捷键"],["lock","隐私"]].map(([i,n])=>`<button class="nav-row ${state.settingsTab===n?"active":""}" data-setting-tab="${n}">${icon(i)}${n}</button>`).join("")}</nav><section class="settings-content"><h3>${state.settingsTab}</h3><p class="section-help">控件立即响应，自动保存结果就地显示。</p>${isAppearance?`<div class="setting-row"><span class="clip-icon">${icon("grid")}</span><div><strong>界面动效</strong><p>自然过渡，跟随系统减少动态效果设置。</p></div><button class="toggle" role="switch" aria-checked="${state.motion}" data-action="toggle-motion" aria-label="界面动效"><span class="toggle-track"></span><span>${state.motion?"开":"关"}</span></button></div><div class="setting-row"><span class="clip-icon">${icon("panel")}</span><div><strong>分组侧边栏</strong><p>按分组整理，收起时保留内容位置。</p></div><button class="toggle" role="switch" aria-checked="${state.sidebar}" data-action="setting-sidebar" aria-label="分组侧边栏"><span class="toggle-track"></span><span>${state.sidebar?"开":"关"}</span></button></div><div class="setting-row"><span class="clip-icon">${icon("image")}</span><div><strong>主题</strong><p>沿用现有六套配色，不改变你的选择。</p></div></div><div class="theme-swatches">${Object.entries(themeNames).map(([key,name])=>`<button class="theme-swatch ${state.theme===key?"active":""}" data-theme-choice="${key}">${name}</button>`).join("")}</div>`:`<div class="setting-row"><span class="clip-icon">${icon(isAppearance?"grid":"settings")}</span><div><strong>${state.settingsTab}设置</strong><p>这一分区沿用现有配置；本稿演示分区切换与反馈，不新增功能。</p></div></div><p class="section-help" style="margin-top:18px">左侧点击其它分区，内容只在必要区域过渡，整页不按行排队出现。</p>`}<div id="settingsError"></div></section></div><footer class="settings-footer"><button class="button ghost" data-action="reset">恢复默认…</button><div class="settings-save"><span id="settingsSaveState" role="status">${icon("check")} 所有更改已保存</span><button class="button primary" data-action="back">完成</button></div></footer>`;
  }
  let labCase="recording";
  function renderLab() {
    clearCaptureObservers();
    let content="";
    if(labCase==="recording") {
      content=`<h2>录制时，把界面让给内容</h2><p>浮条形态沿用现有设计。本稿只演示展开、暂停和完成反馈，计时为示例；不验证系统捕获排除。</p><div class="rec-surface" id="recSurface">${state.recMore&&!state.recTiny?`<section class="rec-details"><dl><dt>画质</dt><dd>高清</dd><dt>电脑声音</dt><dd>开</dd><dt>麦克风</dt><dd>关</dd><dt>已写入</dt><dd>3.5 MB</dd></dl><button class="button" data-action="rec-collapse">收起为小计时</button></section>`:""}${state.recSaved?`<div class="desktop-sheet"><strong>${icon("check")} 录像已保存</strong><p>办公演示.mp4 · 00:37 · 示例<br>结果持续可见，可到最近录制找回。</p><div class="float-case-actions"><button class="button primary" data-action="rec-rerecord">再录一次</button></div></div>`:state.recTiny?`<button class="button rec-row" data-action="rec-expand" aria-label="展开录屏控制条"><span class="rec-dot ${state.recPaused?"paused":""}"></span><span>00:12</span>${icon("chevron")}</button>`:`<div class="rec-row"><span class="rec-time"><i class="rec-dot ${state.recPaused?"paused":""}"></i>00:12</span><button class="button ghost" data-action="rec-pause">${icon(state.recPaused?"play":"pause")}${state.recPaused?"继续":"暂停"}</button><button class="button primary" data-action="rec-stop">${icon("stop")}停止</button><button class="icon-button" data-action="rec-more" aria-label="更多录制信息">${icon("more")}</button></div>`}</div><p>${state.recPaused?"已暂停 · 状态以文字和颜色共同表达":"数字保持稳定，不每秒缩放；录制点不持续扩散。"}</p>`;
    } else if(labCase==="remote") {
      const labels={idle:["已配对的办公电脑","可以连接", "连接"],pending:["正在连接办公电脑","可随时取消，不显示虚假百分比","取消"],error:["连接未完成","示例：网络暂不可用，请重试","重试"],done:["已连接办公电脑","状态确认后才变为成功","断开"]};
      const [title,description,action]=labels[state.connection];
      content=`<h2>连接状态，有始有终</h2><p>状态在同一个位置变化。真实连接、权限申请和远端键鼠路径保持原行为。</p><div class="desktop-sheet"><div class="connection-flow"><span class="connection-icon">${icon("monitor")}</span><div class="connection-copy"><strong>${title}</strong><p>${description}</p></div><button class="button ${state.connection==="idle"?"primary":""}" data-action="connect">${action}</button></div></div>`;
    } else if(labCase==="capture") {
      content=`<h2>直接操作，直接看到结果</h2><p>截图选区和缩放手柄不做缓动追赶。只有帮助与工具菜单渐进出现。</p><div class="desktop-sheet"><strong>拖动下面的终点，调整示例选区</strong><div class="capture-area" id="captureArea">拖拽选区右下角</div><div class="float-case-actions"><span id="captureReadout">520 × 170 · 示例范围</span><button class="button" data-action="capture-help">${icon("more")}选区操作</button></div></div>`;
    } else {
      content=`<h2>编辑时，输入优先</h2><p>面板和工具栏自然衔接；光标、文字输入、画布拖动不经过动画延迟。</p><div class="desktop-sheet"><div class="filter-row"><strong>交互改进计划.md</strong><span id="editorState" class="tag" role="status">已保存</span></div><textarea id="simpleEditor" aria-label="编辑器输入（仅演示）" style="width:100%;min-height:130px;margin-top:12px;padding:12px;border:1px solid var(--border-color);border-radius:8px;background:var(--card-bg);color:var(--text-primary);resize:vertical">让每个动作都有准确的回应。\n让每次变化都保留上下文。</textarea></div>`;
    }
    workspace.innerHTML=`<div class="search-toolbar"><div class="filter-row"><button class="button" data-action="back">${icon("arrow")}返回</button><div class="filter-tabs">${[["recording","录屏"],["capture","截图"],["remote","远程"],["editor","编辑器"]].map(([key,label])=>`<button data-case="${key}" class="${labCase===key?"active":""}">${label}</button>`).join("")}</div></div></div><div class="floating-lab">${content}</div>`;
    if(labCase==="capture") setupCaptureDrag();
  }
  const exercises={
    record:[["add","新增一条"],["slow","慢查询"],["query-error","读取失败"],["menu","菜单与撤销"]],
    tools:[["switch-fast","连续切页"],["float","浮条与工作区"],["reset","确认弹窗"]],
    knowledge:[["new-note","新建与保存"],["save-error","保存失败"],["next-note","切换详情"]],
    settings:[["save-setting","保存反馈"],["setting-error","保存失败"],["reset","恢复默认弹窗"]],
    lab:[["rec-lab","录屏浮条"],["remote-lab","连接状态"],["capture-lab","截图选区"],["editor-lab","编辑反馈"]],
  };
  function renderExercises() {
    $("#exercises").innerHTML=exercises[state.view].map(([key,label])=>`<button class="review-button" data-exercise="${key}">${label}</button>`).join("");
  }
  function render() {
    state.busy=false;
    if(state.view==="record") renderRecord();
    if(state.view==="tools") renderTools();
    if(state.view==="knowledge") renderKnowledge();
    if(state.view==="settings") renderSettings();
    if(state.view==="lab") renderLab();
    const index=["record","tools","knowledge"].indexOf(state.view);
    $$(".app-modes [data-view]").forEach((button,i)=>{button.setAttribute("aria-selected",String(index===i));button.tabIndex=index===i?0:-1;});
    $(".mode-indicator").style.opacity=index>=0?"1":"0";
    if(index>=0) $(".mode-indicator").style.transform=`translateX(${index*44}px)`;
    $("#sidebarToggle").disabled=state.view!=="record"&&state.view!=="knowledge";
    $("#sidebarToggle").setAttribute("aria-label",state.sidebar?"收起侧边栏":"展开侧边栏");
    $("#settingsButton").setAttribute("aria-pressed",String(state.view==="settings"));
    renderExercises();
  }
  function navigate(target, fromSequence=false) {
    if(!fromSequence) sequenceEpoch++;
    clearCaptureObservers();
    const epoch=++navEpoch; queryEpoch++;
    closeMenu(false); closeDialog(false,true);
    animations.forEach(a=>a.cancel());
    if(state.view!=="settings"&&state.view!=="lab") state.previousView=state.view;
    state.view=target;
    if(state.before&&!reduced()) {
      animate(workspace,[{opacity:1,transform:"translateY(0)"},{opacity:0,transform:"translateY(4px)"}],140,"cubic-bezier(.4,0,1,1)");
      schedule(()=>{if(epoch===navEpoch) {render();enter();}},140);
      report("现状示意：旧内容退场 140ms，再入场 180ms，总窗口约 320ms。",320);
    } else {
      render(); enter();
      report("模式立即切换，壳层不动；内容与指示块并行落定。再次点击会直接响应最新选择。",200);
    }
  }
  let toastTimer=null;
  function showToast(message,{error=false,undo=null}={}) {
    cancelJob(toastTimer);
    undoAction=undo;
    const host=$("#toastHost");
    host.innerHTML=`<div class="feedback-toast ${error?"error":""}" role="${error?"alert":"status"}">${icon(error?"warning":"check")}<span class="message">${esc(message)}</span>${undo?'<button class="button" data-action="undo">撤销</button>':""}<button class="icon-button" data-action="dismiss-toast" aria-label="关闭提示">${icon("close")}</button></div>`;
    const toast=host.firstElementChild;
    animate(toast,[{opacity:0,transform:`translateY(${state.direction==="a"?0:-5}px)`},{opacity:1,transform:"translateY(0)"}],150);
    if(!error) toastTimer=schedule(dismissToast,undo?6000:4000);
    const pause=()=>{const job=jobs.get(toastTimer);if(job){job.held=true;if(job.handle){clearTimeout(job.handle);job.remaining=Math.max(0,job.remaining-(performance.now()-job.started));job.handle=null;}}};
    const resume=()=>{const job=jobs.get(toastTimer);if(job){job.held=false;if(!job.handle&&!document.hidden)job.arm();}};
    toast.addEventListener("pointerenter",pause); toast.addEventListener("pointerleave",()=>{if(!toast.contains(document.activeElement))resume();});
    toast.addEventListener("focusin",pause); toast.addEventListener("focusout",()=>schedule(()=>{if(!toast.matches(":hover")&&!toast.contains(document.activeElement))resume();},0));
  }
  function dismissToast() {
    cancelJob(toastTimer); toastTimer=null;
    const element=$(".feedback-toast"); if(!element) return;
    const animation=animate(element,[{opacity:1},{opacity:0}],150);
    if(animation) animation.finished.then(()=>element.remove()).catch(()=>{}); else element.remove();
    undoAction=null;
  }
  function openMenu(anchor,id) {
    closeMenu(false); lastMenuFocus=anchor;
    windowEl.scrollIntoView({block:"center",behavior:"instant"});
    const box=windowEl.getBoundingClientRect(),at=anchor.getBoundingClientRect();
    const left=Math.min(Math.max(8,at.right-box.left-196),box.width-204);
    const top=Math.min(at.bottom-box.top+5,box.height-174);
    const host=$("#menuHost");
    host.innerHTML=`<div class="context-menu" role="menu" aria-label="记录操作" style="left:${left}px;top:${Math.max(8,top)}px"><button role="menuitem" data-copy="${id}">${icon("copy")}复制<kbd>Ctrl C</kbd></button><button role="menuitem" data-pin="${id}">${icon("star")}收藏 / 取消收藏</button><div class="menu-separator"></div><button role="menuitem" class="danger" data-delete="${id}">${icon("trash")}删除记录</button></div>`;
    const element=host.firstElementChild;
    animate(element,[{opacity:0,transform:`translateY(${state.direction==="a"?0:-3}px) scale(${state.direction==="a"?1:.99})`},{opacity:1,transform:"translateY(0) scale(1)"}],150);
    $("[role='menuitem']",element).focus({preventScroll:true});
    report("菜单从触发点进入，移动不超过 3px；Esc 沿原路关闭，并把焦点还给原按钮。",150);
  }
  function closeMenu(restore=true) {
    const menu=$(".context-menu"); if(!menu) return;
    const exit=restore?animate(menu,[{opacity:1,transform:"translateY(0)"},{opacity:0,transform:`translateY(${state.direction==="a"?0:-3}px)`}],150):null;
    menu.style.pointerEvents="none";
    if(exit)exit.finished.then(()=>menu.remove()).catch(()=>menu.remove());else menu.remove();
    if(restore&&lastMenuFocus?.isConnected) lastMenuFocus.focus({preventScroll:true});
  }
  let dialogClosing=false;
  function openDialog() {
    if($(".modal-backdrop")) return;
    closeMenu(); lastDialogFocus=document.activeElement;
    windowEl.scrollIntoView({block:"center",behavior:"instant"});
    const host=$("#dialogHost");
    host.innerHTML=`<div class="modal-backdrop"><section class="modal" role="alertdialog" aria-modal="true" aria-labelledby="dialogTitle" aria-describedby="dialogDescription"><span class="modal-icon">${icon("warning")}</span><h2 id="dialogTitle">恢复默认设置？</h2><p id="dialogDescription">将所有设置恢复为默认值。此操作仅在设计稿中模拟，不会更改软件设置。</p><div class="dialog-actions"><button class="button" data-action="cancel-dialog">取消</button><button class="button danger" data-action="confirm-dialog">恢复默认</button></div></section></div>`;
    const backdrop=host.firstElementChild,panel=$(".modal",backdrop);
    const distance=state.before?38:state.direction==="a"?0:state.direction==="c"?16:12;
    animate(backdrop,[{opacity:0},{opacity:1}],150);
    animate(panel,[{opacity:0,transform:`translateY(${distance}px) scale(${state.direction==="a"?1:.985})`},{opacity:1,transform:"translateY(0) scale(1)"}],state.before?420:300,"cubic-bezier(.05,.7,.1,1)");
    $("[data-action='cancel-dialog']",panel).focus({preventScroll:true});
    report("面板进入 300ms，背板并行淡入；取消默认获得焦点，输入和取消不等动画结束。",300);
  }
  function closeDialog(restore=true,immediate=false) {
    const backdrop=$(".modal-backdrop"); if(!backdrop) return;
    if(immediate) {backdrop.remove();dialogClosing=false;return;}
    if(dialogClosing)return;
    dialogClosing=true;
    const panel=$(".modal",backdrop);
    animate(panel,[{opacity:1,transform:"translateY(0) scale(1)"},{opacity:0,transform:`translateY(${state.direction==="a"?0:8}px) scale(.99)`}],200);
    const a=animate(backdrop,[{opacity:1},{opacity:0}],200);
    const finish=()=>{backdrop.remove();dialogClosing=false;if(restore&&lastDialogFocus?.isConnected)lastDialogFocus.focus({preventScroll:true});};
    if(a)a.finished.then(finish).catch(finish);else finish();
  }
  function saveSettings(error=false) {
    const save=$("#settingsSaveState");if(!save)return;
    save.innerHTML="正在保存…";
    const errorHost=$("#settingsError"); errorHost.innerHTML="";
    schedule(()=>{
      if(!save.isConnected)return;
      save.innerHTML=error?`${icon("warning")} 更改尚未保存`:`${icon("check")} 所有更改已保存`;
      if(error)errorHost.innerHTML=`<div class="inline-error" role="alert"><p>示例：暂时无法保存设置。你的选择仍保留。</p><button class="button" data-action="retry-settings">重新保存</button></div>`;
    },1200);
    report("控件立即改变状态，保存结果在页脚同域反馈。失败说明持续保留，并提供重试。",150);
  }
  let noteSaveJob=null;
  function saveNote(error=false) {
    const label=$("#noteSaveState");if(!label)return;
    cancelJob(noteSaveJob); label.classList.remove("error");label.textContent="保存中…";
    const errorHost=$("#noteSaveError");errorHost.innerHTML="";
    noteSaveJob=schedule(()=>{
      if(!label.isConnected)return;
      label.classList.toggle("error",error);
      label.innerHTML=error?`${icon("warning")} 未保存`:`${icon("check")} 已保存`;
      if(error)errorHost.innerHTML=`<div class="inline-error" role="alert"><p>示例：保存失败，输入内容仍在。</p><button class="button" data-action="retry-note">重试保存</button></div>`;
    },1200);
    report("输入不做缓动；保存状态就地更新，失败保留草稿与可操作的重试入口。",150);
  }
  function addClip() {
    if(state.view!=="record") {state.view="record";render();}
    state.filter="all";state.group="全部";state.query="";
    renderRecord();
    const container=$("#clipList");
    flip(container,()=>{clips.unshift({id:++nextId,kind:"text",icon:"text",title:"刚复制的内容，顺着动作进入列表",meta:"记事本 · 刚刚",pinned:false});clips.splice(8);renderList();});
    status("已加入一条示例记录");report("只强调真正新增的一条；已有内容让位，滚动过程中复用的行不逐条入场。",200);
  }
  function simulateQuery(error=false) {
    if(state.view!=="record") {state.view="record";render();}
    const epoch=++queryEpoch;state.busy=true;
    const feedback=$("#queryFeedback");
    feedback.innerHTML=`<div class="pending-line">正在读取记录，当前结果仍可浏览。<button class="button" data-action="cancel-query">取消</button></div>`;
    schedule(()=>{if(epoch!==queryEpoch||!feedback.isConnected)return;feedback.insertAdjacentHTML("beforeend",'<div class="skeleton" aria-hidden="true"></div>');},1000);
    schedule(()=>{
      if(epoch!==queryEpoch||!feedback.isConnected)return;state.busy=false;
      feedback.innerHTML=error?`<div class="inline-error" role="alert">${icon("warning")}<p>示例：记录读取失败，当前结果已保留。</p><button class="button" data-action="retry-query">重试</button></div>`:"";
      status(error?"记录尚未更新，可重试":"读取完成 · 示例");
    },2200);
    report("慢请求先明确正在处理，超过 1 秒再给静态骨架占位。旧结果不清空，失败不会假装空列表。",150);
  }
  function copyFeedback(id,button) {
    closeMenu();
    const inline=$(`[data-row='${id}'] .copy-button`)||button;
    if(!inline) {showToast("已复制（演示）");return;}
    inline.classList.add("confirmed");inline.innerHTML=`${icon("check")}<span>已复制</span>`;
    schedule(()=>{if(inline.isConnected){inline.classList.remove("confirmed");inline.innerHTML=`${icon("copy")}<span>复制</span>`;}},1500);
    status("已复制（仅演示，未写入系统剪贴板）");
    report("复制在原按钮变为对勾与文字，不让每次高频操作都弹一条通知。",150);
  }
  function pinClip(id) {
    const item=clips.find(c=>c.id===id);if(!item)return;
    closeMenu(false);
    const container=$("#clipList");
    flip(container,()=>{item.pinned=!item.pinned;if(item.pinned){clips.splice(clips.indexOf(item),1);clips.unshift(item);}renderList();});
    $(`[data-pin='${id}']`)?.focus({preventScroll:true});
    report("收藏状态立即确认，可见行在 200ms 内补位；不测量或驱动整个历史库。",200);
  }
  function deleteClip(id) {
    const index=clips.findIndex(c=>c.id===id);if(index<0)return;
    const removed=clips[index];closeMenu(false);
    const list=$("#clipList");flip(list,()=>{clips.splice(index,1);renderList();});
    $(".clip")?.focus({preventScroll:true});
    showToast("记录已删除（示例）",{undo:()=>{clips.splice(Math.min(index,clips.length),0,removed);if(state.view==="record")renderList();status("已撤销删除");}});
    report("可恢复删除用撤销，不反复打断。撤销保留 6 秒，鼠标悬停或键盘聚焦都会停表。",200);
  }
  function fastSwitch() {
    const epoch=++sequenceEpoch;
    const sequence=["tools","knowledge","record"];
    sequence.forEach((view,i)=>schedule(()=>{if(epoch===sequenceEpoch)navigate(view,true);},i*100));
    report("连续输入时更新到最新目标，不把三次点击排成三轮退场和入场。",200);
  }
  function runExercise(action) {
    if(action==="add")addClip();
    if(action==="slow")simulateQuery(false);
    if(action==="query-error")simulateQuery(true);
    if(action==="menu") {const button=$("[data-menu]");if(button)openMenu(button,Number(button.dataset.menu));}
    if(action==="switch-fast")fastSwitch();
    if(action==="float"||action==="rec-lab") {labCase="recording";navigate("lab");}
    if(action==="remote-lab") {labCase="remote";navigate("lab");}
    if(action==="capture-lab") {labCase="capture";navigate("lab");}
    if(action==="editor-lab") {labCase="editor";navigate("lab");}
    if(action==="reset")openDialog();
    if(action==="save-setting")saveSettings(false);
    if(action==="setting-error")saveSettings(true);
    if(action==="new-note") {state.note=3;state.draft="";renderKnowledge();enter($("#noteDetail"));$("#noteEditor")?.focus({preventScroll:true});report("新建后立即能输入；焦点落到编辑区，保存状态与内容在同一可见区域。",200);}
    if(action==="save-error")saveNote(true);
    if(action==="next-note") {state.note=(state.note+1)%notes.length;renderKnowledge();enter($("#noteDetail"));report("只有详情区轻量更新，文件夹、列表和编辑器外壳保持稳定。",200);}
  }
  function setTheme(key) {
    state.theme=key;document.documentElement.dataset.theme=key;$("#theme").value=key;
    $(".brand img").src=key==="blossom"?"../src/assets/melody.png":"../public/icon.png";
    if(state.view==="settings") {renderSettings();saveSettings(false);}
    report("沿用现有主题令牌；提高工作区文字与控件层级，背景不增加持续运动。",150);
  }
  function describeDirection() {
    const content={
      a:["方案 A","原位精修，成本最低","保留布局，用颜色、透明度和原位状态把手感统一。视觉变化较小，连续位移的表达较弱。"],
      b:["推荐方案 B","克制，但有连续感","外壳保持稳定，动效只解释变化。列表不随悬停浮动，操作在原位得到回应。"],
      c:["方案 C","少量轻弹，表达更鲜明","在模式指示与小型形态变化上使用现有定参弹簧。普通文本和列表仍克制，需多验收尾部与原生小窗边界。"],
    }[state.direction];
    $("#directionTag").textContent=content[0];$("#directionTitle").textContent=content[1];$("#directionDescription").textContent=content[2];
  }
  function setupCaptureDrag() {
    const area=$("#captureArea");if(!area)return;
    area.style.resize="both";area.style.overflow="auto";area.style.maxWidth="100%";area.style.minWidth="140px";area.style.height="170px";
    let observer;
    if(typeof ResizeObserver!=="undefined") {
      observer=new ResizeObserver(entries=>{const rect=entries[0].contentRect;const readout=$("#captureReadout");if(readout)readout.textContent=`${Math.round(rect.width)} × ${Math.round(rect.height)} · 示例范围`;});
      observer.observe(area);
      area.addEventListener("pointerdown",()=>report("拖拽跟手，不加 transform 缓动，也不等入场完成后才允许操作。",0),{once:true});
      captureObservers.add(observer);
    }
  }
  const captureObservers=new Set();
  function clearCaptureObservers(){captureObservers.forEach(o=>o.disconnect());captureObservers.clear();}
  document.addEventListener("click",event=>{
    const button=event.target.closest("button");
    if(!button) {if(!event.target.closest(".context-menu"))closeMenu();return;}
    if(button.disabled)return;
    if(button.dataset.direction) {
      state.direction=button.dataset.direction;document.documentElement.dataset.direction=state.direction;
      $$(".direction-picker button").forEach(b=>b.setAttribute("aria-pressed",String(b===button)));describeDirection();report("方案已切换。先试一次模式切换、原位复制或打开弹窗。",200);return;
    }
    if(button.dataset.view) {navigate(button.dataset.view);return;}
    if(button.dataset.filter) {state.filter=button.dataset.filter;queryEpoch++;renderRecord();report("筛选即刻生效，保留搜索输入和壳层；普通筛选不让每行重新飞入。",150);return;}
    if(button.dataset.group) {state.group=button.dataset.group;renderRecord();enter($("#clipList"));return;}
    if(button.dataset.folder) {button.closest(".sidebar").querySelectorAll(".nav-row").forEach(row=>row.classList.toggle("active",row===button));status(`${button.dataset.folder} · 本稿仅演示文件夹选择反馈`);return;}
    if(button.dataset.category) {state.category=button.dataset.category;renderTools();enter($("#toolGrid"));return;}
    if(button.dataset.copy) {copyFeedback(Number(button.dataset.copy),button);return;}
    if(button.dataset.pin) {pinClip(Number(button.dataset.pin));return;}
    if(button.dataset.menu) {openMenu(button,Number(button.dataset.menu));return;}
    if(button.dataset.delete) {deleteClip(Number(button.dataset.delete));return;}
    if(button.dataset.exercise) {runExercise(button.dataset.exercise);return;}
    if(button.dataset.note) {state.note=Number(button.dataset.note);state.draft="";renderKnowledge();enter($("#noteDetail"));report("切换笔记只更新详情；持续编辑和焦点不会为了播放整页动画而等待。",200);return;}
    if(button.dataset.settingTab) {state.settingsTab=button.dataset.settingTab;renderSettings();enter($(".settings-content"));return;}
    if(button.dataset.themeChoice) {setTheme(button.dataset.themeChoice);return;}
    if(button.dataset.case) {labCase=button.dataset.case;captureObservers.forEach(o=>o.disconnect());captureObservers.clear();renderLab();enter();return;}
    if(button.dataset.tool) {
      if(button.dataset.tool==="屏幕录制") {labCase="recording";navigate("lab");}
      else if(button.dataset.tool==="远程电脑") {labCase="remote";navigate("lab");}
      else {showToast(`${button.dataset.tool}入口响应（设计演示）`);report("工具入口使用原工具名与位置。这里演示按压及启动反馈，不执行真实工具。",150);}
      return;
    }
    if(button.dataset.lab) {
      if(button.dataset.lab==="touch") {animate(button,[{transform:"scale(.98)"},{transform:"scale(1)"}],150);showToast("操作已确认（示例）");}
      if(button.dataset.lab==="switch")fastSwitch();
      if(button.dataset.lab==="dialog")openDialog();
      if(button.dataset.lab==="editor"){labCase="editor";navigate("lab");}
      windowEl.scrollIntoView({block:"center",behavior:"instant"});return;
    }
    const action=button.dataset.action;
    if(action==="back")navigate(state.previousView);
    if(action==="reset")openDialog();
    if(action==="cancel-dialog")closeDialog();
    if(action==="confirm-dialog"){closeDialog();showToast("默认设置已恢复（仅模拟）");}
    if(action==="dismiss-toast")dismissToast();
    if(action==="undo"){const undo=undoAction;dismissToast();undo?.();}
    if(action==="clear-filter"){state.query="";state.filter="all";state.group="全部";renderRecord();}
    if(action==="cancel-query"){queryEpoch++;state.busy=false;$("#queryFeedback").innerHTML="";status("读取已取消，当前内容保留");}
    if(action==="retry-query")simulateQuery(false);
    if(action==="new-group")showToast("保留原分组创建流程，此处只演示入口反馈");
    if(action==="new-note")runExercise("new-note");
    if(action==="retry-note")saveNote(false);
    if(action==="retry-settings")saveSettings(false);
    if(action==="toggle-motion"){state.motion=!state.motion;syncReduced();renderSettings();saveSettings(false);}
    if(action==="setting-sidebar"){state.sidebar=!state.sidebar;renderSettings();saveSettings(false);}
    if(action==="rec-more"){state.recMore=!state.recMore;renderLab();enter($(".rec-details")||$(".rec-row"));report("详情按需出现，正常录制没有数字弹跳、呼吸波纹或周期性干扰。",200);}
    if(action==="rec-pause"){state.recPaused=!state.recPaused;renderLab();report("暂停/继续以文字、图标、状态色共同确认。计时和浮条位置保持稳定。",150);}
    if(action==="rec-collapse"){state.recTiny=true;state.recMore=false;renderLab();enter($("#recSurface"));}
    if(action==="rec-expand"){state.recTiny=false;renderLab();enter($("#recSurface"));}
    if(action==="rec-stop"){state.recSaved=true;renderLab();enter($("#recSurface"));report("重要产物保留明确结果入口，不使用短时提示代替保存结果。",200);}
    if(action==="rec-rerecord"){state.recSaved=false;renderLab();}
    if(action==="record-preview"){labCase="editor";navigate("lab");report("设计稿仅演示编辑区和保存反馈，不播放或裁剪真实文件。",200);}
    if(action==="connect") {
      const epoch=++connectionEpoch;
      if(state.connection==="pending"){state.connection="idle";renderLab();return;}
      if(state.connection==="done"){state.connection="idle";renderLab();return;}
      const retry=state.connection==="error";state.connection="pending";renderLab();
      schedule(()=>{if(epoch!==connectionEpoch||state.view!=="lab"||labCase!=="remote"||state.connection!=="pending")return;state.connection=retry?"done":"error";renderLab();},1800);
      report("连接中保留取消，失败说明与重试不离开原位置；示例首次失败，重试成功。",150);
    }
    if(action==="capture-help"){showToast("示例：拖拽直接改范围；Esc 返回上一步");}
  });
  let editorJob=null;
  document.addEventListener("input",event=>{
    if(event.target.id==="recordSearch"){state.query=event.target.value;queryEpoch++;state.busy=false;$("#queryFeedback").innerHTML="";renderList();report("输入实时更新结果，不为了动画节流输入；虚拟行不重复播放入场。",150);}
    if(event.target.id==="toolSearch")renderToolGrid();
    if(event.target.id==="noteSearch"){const q=event.target.value.toLowerCase();$$(".note-row").forEach(row=>{row.hidden=!row.textContent.toLowerCase().includes(q);});}
    if(event.target.id==="noteEditor"){state.draft=event.target.value;saveNote(false);}
    if(event.target.id==="simpleEditor") {
      cancelJob(editorJob);const label=$("#editorState");label.textContent="保存中…";
      editorJob=schedule(()=>{if(label.isConnected)label.textContent="已保存";},1000);
    }
    if(event.target.id==="settingSearch") {
      const q=event.target.value.trim();$$(".setting-row").forEach(row=>{row.hidden=q&&!row.textContent.includes(q);});
      report("设置搜索直接筛选当前示例行；真实产品跨分区搜索行为保持不变。",150);
    }
  });
  document.addEventListener("change",event=>{
    if(event.target.id==="timeFilter"||event.target.id==="sourceFilter") {status(`筛选已切换：${event.target.value}（示意）`);report("筛选反馈立即出现，演示数据不代表实际历史数量。",150);}
  });
  document.addEventListener("keydown",event=>{
    const dialog=$(".modal");
    if(dialog&&event.key==="Tab") {const nodes=$$("button",dialog);const first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}return;}
    if(event.key==="Escape") {if(dialog){event.preventDefault();closeDialog();}else if($(".context-menu")){event.preventDefault();closeMenu();}else if(state.view==="lab"||state.view==="settings"){event.preventDefault();navigate(state.previousView);}return;}
    const menu=$(".context-menu");
    if(menu&&["ArrowUp","ArrowDown","Home","End"].includes(event.key)){event.preventDefault();const buttons=$$("button",menu);let index=buttons.indexOf(document.activeElement);index=event.key==="Home"?0:event.key==="End"?buttons.length-1:(index+(event.key==="ArrowDown"?1:-1)+buttons.length)%buttons.length;buttons[index].focus();return;}
    if(event.target.closest(".app-modes")&&["ArrowLeft","ArrowRight","Home","End"].includes(event.key)){event.preventDefault();const buttons=$$(".app-modes [data-view]");let i=buttons.indexOf(document.activeElement);i=event.key==="Home"?0:event.key==="End"?2:(i+(event.key==="ArrowRight"?1:-1)+3)%3;navigate(buttons[i].dataset.view);buttons[i].focus();return;}
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="f"&&windowEl.contains(document.activeElement)){const input=$("input",workspace);if(input){event.preventDefault();input.focus();input.select();}}
  });
  $("#sidebarToggle").innerHTML=icon("panel");$("#settingsButton").innerHTML=icon("settings");
  $$("[data-icon]").forEach(el=>el.innerHTML=icon(el.dataset.icon));
  $("#sidebarToggle").addEventListener("click",()=>{
    state.sidebar=!state.sidebar;
    const sidebar=$(".sidebar",workspace);
    if(sidebar){sidebar.classList.toggle("collapsed",!state.sidebar);sidebar.inert=!state.sidebar;}
    $("#sidebarToggle").setAttribute("aria-label",state.sidebar?"收起侧边栏":"展开侧边栏");
    report("侧栏开合保持壳层稳定；落地需保护虚拟列表测量、滚动锚点与最后一次用户意图。",200);
  });
  $("#settingsButton").addEventListener("click",()=>navigate(state.view==="settings"?state.previousView:"settings"));
  $$(".demo-window-action").forEach(button=>button.addEventListener("click",()=>showToast("窗口按钮为示意，不控制你的电脑")));
  $("#replay").addEventListener("click",()=>{render();enter();report("重放只作用于当前内容层，标题栏和常用入口不参与整页入场。",200);});
  $("#theme").addEventListener("change",event=>setTheme(event.target.value));
  $("#comparison").addEventListener("change",event=>{state.before=event.target.value==="before";windowEl.classList.toggle("baseline",state.before);report(state.before?"现状时序示意：模拟当前代码中的串行切换、整卡放大与扫光。请用同一操作对照。":"方案预览：取消反复装饰，把运动留给有意义的状态变化。",state.before?320:200);});
  $("#compact").addEventListener("change",event=>{$("#reviewLayout").classList.toggle("compact-layout",event.target.checked);report("紧凑窗口采用结构适配，不把整页缩小成难点的小字。",200);});
  $("#reduced").checked=osReduced.matches;syncReduced();
  $("#reduced").addEventListener("change",()=>{syncReduced();report("减少动态时取消空间位移和回弹；文字、颜色、保存状态和恢复操作仍然可见。",150);});
  osReduced.addEventListener("change",event=>{$("#reduced").checked=event.matches;syncReduced();});
  document.addEventListener("visibilitychange",()=>{
    document.documentElement.classList.toggle("prototype-hidden",document.hidden);
    if(document.hidden){jobs.forEach(job=>{if(job.handle){clearTimeout(job.handle);job.remaining=Math.max(0,job.remaining-(performance.now()-job.started));job.handle=null;}});animations.forEach(a=>{if(a.playState==="running")a.pause();});captureObservers.forEach(o=>o.disconnect());}
    else {jobs.forEach(job=>{if(!job.handle&&!job.held)job.arm();});animations.forEach(a=>{if(a.playState==="paused")a.play();});if(state.view==="lab"&&labCase==="capture"){captureObservers.clear();setupCaptureDrag();}}
  });
  render();describeDirection();
})();
