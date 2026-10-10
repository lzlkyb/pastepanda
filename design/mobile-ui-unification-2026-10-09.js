(() => {
  'use strict';
  const app = document.getElementById('app');
  const phone = document.getElementById('phone');
  const layer = document.getElementById('sheetLayer');
  const paths = {
    monitor:'<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
    file:'<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    book:'<path d="M4 3h14a2 2 0 0 1 2 2v16H6a2 2 0 0 1-2-2Zm0 14h16M8 7h8M8 11h6"/>',
    settings:'<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="9" cy="18" r="2"/>',
    plus:'<path d="M12 5v14M5 12h14"/>', back:'<path d="m12 5-7 7 7 7M5 12h15"/>',
    close:'<path d="m6 6 12 12M18 6 6 18"/>', check:'<path d="m5 12 4 4L19 6"/>',
    chevron:'<path d="m9 5 7 7-7 7"/>', search:'<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/>',
    sync:'<path d="M20 7a8 8 0 0 0-14-2L3 8M3 3v5h5M4 17a8 8 0 0 0 14 2l3-3M21 21v-5h-5"/>',
    error:'<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 17h.01"/>',
    more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    mouse:'<rect x="6" y="2" width="12" height="20" rx="6"/><path d="M12 2v7M6 9h12"/>',
    keyboard:'<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M7 16h10"/>',
    image:'<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1"/><path d="m21 15-6-6L3 21"/>',
    star:'<path d="m12 3 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1Z"/>',
    share:'<path d="M12 16V3m-5 5 5-5 5 5M5 12v8h14v-8"/>'
  };
  const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.more}</svg>`;
  const names = { devices:'设备',files:'文件',knowledge:'知识库',editor:'统一编辑器',remote:'远程画面',settings:'设置',reader:'阅读正文' };
  const notes = {
    devices:'空态突出添加入口；有设备时由页头添加，列表直接连接，管理留在详情。',
    files:'切换设备清楚地切换操作归属；文件收到以后可以打开、分享或导出（拟新增平台能力）。',
    knowledge:'同步入口在列表上方；待收集内容显示为入口，不自动打断当前任务。',
    editor:'新建和修改共用视觉结构；分类前置是拟新增能力，草稿、冲突与保存语义继续分别处理。',
    remote:'画面为主；只显示一套鼠标操作，反馈在工具滚动区之外，返回保留来源。',
    settings:'单选统一使用选中勾选；主按钮只代表执行动作；会话记录使用手机字号。',
    reader:'收藏只保留一个常驻入口；低频操作进入更多，简短回执不长期挤占正文。'
  };
  let screen = 'knowledge', peer = '工作电脑', mode = '触控板', quality = '均衡', favorite = false, editing = false;
  let feedback = null, timer = null, remaining = 0, started = 0, stack = [], originFocus = null;
  const editorDraft = { title:'项目交接要点',body:'交接前确认账号权限、运行手册和待处理事项。\n\n记录只保存在此原型内，不会写入手机。',folder:'未分类' };
  const head = (title,action='') => `<header class="page-head"><h2>${title}</h2>${action}</header>`;
  const button = (action,text,cls='text-button',glyph='') => `<button class="${cls}" data-action="${action}"${!text?` aria-label="${action==='leaveRemote'?'结束会话':action==='readerMore'?'阅读操作':'返回上一层'}"`:''}>${glyph?icon(glyph):''}${text}</button>`;
  function nav() { return `<nav class="nav" aria-label="主要页面">${[['devices','monitor'],['files','file'],['knowledge','book'],['settings','settings']].map(([key,i])=>`<button data-screen="${key}" aria-pressed="${screen===key || key==='knowledge'&&['editor','reader'].includes(screen)}">${icon(i)}<span>${names[key]}</span></button>`).join('')}</nav>`; }
  function receipt() {
    if (!feedback) return '';
    return `<section class="feedback" data-tone="${feedback.tone}" role="${feedback.tone==='error'?'alert':'status'}">${icon(feedback.tone==='error'?'error':'check')}<div class="message"><strong>${feedback.title}</strong>${feedback.detail?`<small>${feedback.detail}</small>`:''}</div>${feedback.tone==='error'?button('retry','重试'):''}<button class="icon-button" data-action="dismiss" aria-label="关闭提示">${icon('close')}</button></section>`;
  }
  function row(title,detail,action,i='chevron') { return `<button class="row" data-action="${action}"><span class="row-text"><strong>${title}</strong><small>${detail}</small></span>${icon(i)}</button>`; }
  function devices() { return `${head('设备',button('add','添加电脑','text-button','plus'))}<div class="scroll"><p class="subtle">已配对的电脑</p><div class="group">${row('工作电脑','已连接 · 可控制','connect','monitor')}${row('家用电脑','等待电脑上线','deviceDetails','monitor')}</div>${button('uno','使用无人值守凭证','secondary')}<p class="subtle">连接遇到问题时，在设备操作区域提供恢复入口。</p></div><footer class="footer">${receipt()}</footer>`; }
  function files() { return `${head('文件',button('peer',peer))}<div class="scroll"><p class="subtle">传输对象：${peer}</p><div class="actions">${button('sendFile','发送文件','primary')}${button('pullFile','从电脑取回','secondary')}</div><h3>传输记录</h3><div class="group">${row('项目说明.pdf','已收到 · 2.4 MB · 工作电脑','fileDetails','file')}</div><p class="subtle">已收到的文件保留在手机；清除记录不会删除文件。</p>${button('clearRecords','清除已结束记录')}</div><footer class="footer">${receipt()}</footer>`; }
  function knowledge() { return `${head('知识库',button('newNote','新建','text-button','plus'))}<div class="scroll"><button class="status-entry" data-action="sync">${icon('sync')}<span>电脑同步 · 最近成功 09:20</span><span class="expand">详情</span></button><label class="search">${icon('search')}<input id="noteSearch" placeholder="搜索笔记与资料" aria-label="搜索笔记与资料"></label><div class="tabs" aria-label="笔记视图"><button aria-pressed="true" data-action="noteTab">最近</button><button aria-pressed="false" data-action="noteTab">常用</button><button aria-pressed="false" data-action="noteTab">全部</button>${button('filter','筛选')}</div><button class="status-entry" data-action="collection">${icon('image')}<span>待收集 1 条</span><span class="expand">预览</span></button><div class="group" id="noteRows">${['项目交接要点','远程办公检查清单','本周工作记录','接口联调说明','出差资料'].map((t,i)=>`<button class="row note" data-action="read"><span class="row-text"><strong>${t}</strong><small>${i===0?'账号权限、运行手册与待处理事项。':'打开查看完整正文与关联资料。'}</small><small class="date">工作资料 · 今天</small></span></button>`).join('')}</div>${button('pickImage','从手机收集图片','secondary')}</div><footer class="footer">${receipt()}</footer>`; }
  function editor() { return `${head(editing?'修改笔记':'新建笔记',button('preview','预览'))}<div class="scroll"><label class="editor-label" for="noteTitle">标题（可后填）</label><input id="noteTitle" class="editor-input"><label class="editor-label" for="noteBody">内容</label><textarea id="noteBody" class="editor-body"></textarea><div class="editor-tools">${button('pickImage','图片','text-button','image')}${button('classify',editorDraft.folder,'text-button','file')}</div><p class="subtle">返回会保留草稿。电脑同步进度在知识库查看。</p></div><footer class="footer">${receipt()}${button('saveNote',editing?'保存修改到手机':'保存到手机','primary')}</footer>`; }
  function reader() { return `${head('项目交接要点',button('readerMore','更多','icon-button','more'))}<article class="scroll reader-body"><p class="subtle">工作资料 · 今天更新</p><h3>交接前，确认这三件事。</h3><p>整理账号权限、运行手册和待处理事项，让接手的人能直接找到需要的信息。</p><h3>账号与权限</h3><p>核对需要移交的账号，并在原系统中完成权限调整。</p><h3>运行手册</h3><p>记录环境要求、部署步骤、日常检查与故障处理方式。</p><h3>待处理事项</h3><p>写清当前进度、依赖事项和下一步负责人。手机阅读优先呈现正文，工具保持简洁。</p></article><footer class="footer">${receipt()}<div class="actions">${button('favorite',favorite?'手机常用':'加入手机常用','secondary','star')}${button('toc','目录','secondary','book')}</div></footer>`; }
  function remote() { return `<section class="remote"><div class="remote-stage"><header class="remote-header">${button('leaveRemote','','icon-button','back')}<span class="device-name"><strong>工作电脑</strong><small>控制中</small></span><span class="latency">8 ms</span>${button('quality',quality)}</header><div class="remote-feedback">${receipt()}</div><div class="desktop"><div class="desktop-window"><div class="desktop-title">${icon('monitor')} 远程桌面内容示意</div><div class="desktop-content"><h3>项目交接文档</h3><table><tr><td>账号权限</td><td>已核对</td></tr><tr><td>运行手册</td><td>已整理</td></tr><tr><td>待处理事项</td><td>3 项</td></tr></table></div></div></div><p class="mode-hint">${mode==='直接点击'?'直接点击画面上的位置':mode==='浮动鼠标'?'在浮动指针附近滑动定位':mode==='独立触控板'?'在独立触控区域滑动指针':'滑动移动指针 · 双指轻点右键'}</p>${mode==='浮动鼠标'?`<div class="mouse-actions">${button('leftClick','左键','secondary')}${button('rightClick','右键','secondary')}${button('drag','拖拽','secondary')}${button('scroll','滚动','secondary')}</div>`:''}</div><nav class="remote-tools" aria-label="远程工具">${button('mode',mode,'text-button','mouse')}${button('keyboard','键盘','text-button','keyboard')}${button('quality','画面','text-button','monitor')}${button('remoteMore','更多','text-button','more')}</nav></section>`; }
  function settings() { return `${head('设置')}<div class="scroll"><div class="group">${row('远程通道','已开启 · 管理连接能力','channel','monitor')}${row('操作习惯',mode,'mode','mouse')}${row('外观',document.getElementById('dark').checked?'深色':'浅色','appearance','settings')}</div><h3>记录与帮助</h3><div class="group">${row('会话记录','工作电脑 · 今天 09:20 · 控制','history','file')}${row('使用帮助','连接、输入与文件问题','help','book')}</div></div><footer class="footer">${receipt()}</footer>`; }
  function render() {
    app.innerHTML = screen==='remote'?remote():`<section class="page">${({devices,files,knowledge,editor,reader,settings})[screen]()}</section>${nav()}`;
    if (screen==='editor') { document.getElementById('noteTitle').value=editorDraft.title; document.getElementById('noteBody').value=editorDraft.body; }
    document.getElementById('screenName').textContent=names[screen]; document.getElementById('stageNote').textContent=notes[screen];
    document.querySelectorAll('#screenOptions button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.screen===screen)));
  }
  function stopTimer() { if(timer) { clearTimeout(timer); remaining=Math.max(0,remaining-(performance.now()-started)); timer=null; } }
  function resumeTimer() { if(!timer && remaining>0 && feedback?.tone==='success' && !document.hidden && !stack.length) { started=performance.now(); timer=setTimeout(()=>{timer=null;feedback=null;remaining=0;render();},remaining); } }
  function notify(tone,title,detail='') { stopTimer(); feedback={tone,title,detail}; remaining=tone==='success'?4000:0; render(); resumeTimer(); }
  function choice(value,selected,action,detail='') { return `<button class="choice" role="radio" aria-checked="${value===selected}" data-action="${action}" data-value="${value}"><span class="row-text"><strong>${value}</strong>${detail?`<small>${detail}</small>`:''}</span><span class="check">${value===selected?icon('check'):''}</span></button>`; }
  function panelContent(type) {
    switch(type) {
      case 'mode': return ['操作方式',`<div role="radiogroup" aria-label="操作方式">${[['触控板','在远程画面上滑动指针'],['直接点击','直接点电脑上的目标'],['独立触控板','用独立区域控制指针'],['浮动鼠标','用浮动指针精确定位']].map(([v,d])=>choice(v,mode,'setMode',d)).join('')}</div>`];
      case 'quality': return ['画面与画质',`<div role="radiogroup" aria-label="画质档位">${['流畅','均衡','高清'].map(v=>choice(v,quality,'setQuality')).join('')}</div><p class="subtle">接收确认后才报告电脑已接受。此处仅演示反馈。</p>`];
      case 'remoteMore': return ['更多工具',`${row('画面与画质',quality,'quality','monitor')}${row('操作方式',mode,'mode','mouse')}${row('结束会话','返回设备列表','end','back')}`];
      case 'keyboard': return ['键盘输入',`<div class="tabs">${button('textInput','文字输入','secondary')}${button('keyInput','逐键直传','secondary')}</div><label class="editor-label" for="remoteText">文字输入</label><textarea id="remoteText" class="editor-body" placeholder="输入中文或一段文字"></textarea>${button('sendText','发送到电脑','primary')}`];
      case 'textModeHelp': return ['逐键直传',`<p>逐键直传适合快捷键；输入中文可直接切回文字输入。</p>${button('backToText','切到文字输入','primary')}`];
      case 'peer': return ['传输对象',`<div role="radiogroup" aria-label="传输对象">${['工作电脑','家用电脑'].map(v=>choice(v,peer,'setPeer')).join('')}</div>`];
      case 'fileDetails': return ['项目说明.pdf',`<p class="subtle">已收到 · 工作电脑 · 2.4 MB</p>${row('打开文件','由系统选择合适的应用','openFile','file')}${row('分享文件','使用 Android 系统分享','shareFile','share')}${row('保存到其他位置','选择可访问的目标目录','exportFile','file')}<p class="subtle">以上为拟新增平台流程，原型不会调用系统或访问文件。</p>`];
      case 'sync': return ['知识库同步',`<p class="subtle">此原型展示已授权设备的状态。实际首次授权仍须明确确认整个当前知识库的双向同步范围。</p><div class="group">${row('工作电脑','最近成功 09:20 · 无待处理问题','syncDetails','monitor')}</div>${button('runSync','立即同步','primary')}${button('syncDetails','设备与同步详情')}<p class="subtle">暂停和撤销授权沿用现有安全流程。</p>`];
      case 'syncDetails': return ['同步详情',`<p>工作电脑</p><p class="subtle">身份、最近同步报告、失败诊断在此按需查看。原型不展示真实设备身份。</p>${button('runSync','重试同步','primary')}`];
      case 'collection': return ['收集预览',`<h4>分享来的交接要点</h4><p class="subtle">整理需要保留的内容；不会自动下载网页或图片。</p>${button('collectSave','保存到手机','primary')}${button('collectEdit','继续编辑','secondary')}<p class="subtle">直接保存是拟新增快捷流程；已有草稿时必须先选择去向，不能覆盖。</p>`];
      case 'classify': return ['文件夹与标签',`<div role="radiogroup" aria-label="文件夹">${['未分类','工作资料','个人记录'].map(v=>choice(v,editorDraft.folder,'setFolder')).join('')}</div><p class="subtle">新建时直接分类为拟新增能力；不会自动取得电脑端分类。</p>`];
      case 'readerMore': return ['阅读操作',`${row('修改笔记','保留草稿与版本冲突处理','editNote','book')}${row('分享正文','调用系统分享前查看内容','shareText','share')}${row('检查本机更新','同步结果另行查看','checkUpdate','sync')}`];
      case 'appearance': return ['外观',`<div role="radiogroup" aria-label="外观">${['浅色','深色'].map(v=>choice(v,document.getElementById('dark').checked?'深色':'浅色','setAppearance')).join('')}</div>`];
      case 'end': return ['结束会话？',`<p>结束与工作电脑的控制连接，然后返回设备。</p>${button('finishRemote','结束会话','primary')}${button('panelBack','继续连接','secondary')}`];
      case 'preview': return ['笔记预览','<article class="reader-body" id="draftPreview"></article>'];
      case 'toc': return ['文章目录',`${row('账号与权限','查看这一段','jumpSection','book')}${row('运行手册','查看这一段','jumpSection','book')}${row('待处理事项','查看这一段','jumpSection','book')}`];
      default: return [{add:'添加电脑',uno:'无人值守连接',deviceDetails:'设备详情',channel:'远程通道',history:'会话记录',help:'使用帮助',filter:'筛选笔记',pickImage:'收集图片',sendFile:'发送文件',pullFile:'从电脑取回'}[type]||'操作详情',`<p class="subtle">这一流程沿用现有能力，本原型聚焦入口、返回和反馈规则。</p>${button('demoDone','完成演示','primary')}`];
    }
  }
  function showPanel(type) { if(!stack.length) { originFocus=document.activeElement; stopTimer(); } stack.push(type); drawPanel(); }
  function drawPanel() {
    if(!stack.length) { layer.hidden=true; app.inert=false; if(originFocus?.isConnected)originFocus.focus(); resumeTimer(); return; }
    const [title,body]=panelContent(stack[stack.length-1]); app.inert=true; layer.hidden=false;
    layer.innerHTML=`<section class="sheet" role="dialog" aria-modal="true" aria-labelledby="panelTitle"><header class="sheet-head">${stack.length>1?button('panelBack','','icon-button','back'):''}<h3 id="panelTitle">${title}</h3><button class="icon-button" aria-label="关闭全部面板" data-action="closePanels">${icon('close')}</button></header><div class="scroll">${body}</div></section>`;
    if (stack[stack.length-1]==='preview') document.getElementById('draftPreview').textContent=editorDraft.title+'\n\n'+editorDraft.body;
    layer.querySelector('button')?.focus();
  }
  function closePanels() { stack=[];drawPanel(); }
  function changeScreen(value) { closePanels(); stopTimer(); feedback=null; remaining=0; screen=value; render(); }
  function action(name,target) {
    if(name==='panelBack') {stack.pop();drawPanel();return;}
    if(name==='closePanels'){closePanels();return;}
    if(name==='dismiss'){stopTimer();feedback=null;remaining=0;render();return;}
    if(name==='noteTab'){target.parentElement.querySelectorAll('[aria-pressed]').forEach(b=>b.setAttribute('aria-pressed',String(b===target)));return;}
    if(name==='read'){changeScreen('reader');return;}
    if(name==='newNote'||name==='editNote'){editing=name==='editNote';changeScreen('editor');return;}
    if(name==='connect'){changeScreen('remote');return;}
    if(name==='setMode'){mode=target.dataset.value;closePanels();notify('success','已切换到'+mode,'操作方式演示');return;}
    if(name==='setQuality'){quality=target.dataset.value;closePanels();notify('success','电脑已接受：'+quality,'模拟确认回执');return;}
    if(name==='setPeer'){peer=target.dataset.value;closePanels();feedback=null;stopTimer();remaining=0;render();return;}
    if(name==='setFolder'){editorDraft.folder=target.dataset.value;stack.pop();render();drawPanel();return;}
    if(name==='setAppearance'){document.getElementById('dark').checked=target.dataset.value==='深色';document.documentElement.dataset.theme=target.dataset.value==='深色'?'ocean-dark':'ocean';stack.pop();render();drawPanel();return;}
    if(name==='favorite'){favorite=!favorite;notify('success',favorite?'已加入手机常用':'已移出手机常用');return;}
    if(name==='saveNote'||name==='collectSave'){changeScreen('reader');notify('success','已保存到手机','原型演示，未写入真实笔记');return;}
    if(name==='collectEdit'){editing=false;changeScreen('editor');return;}
    if(name==='finishRemote'){changeScreen('devices');return;}
    if(name==='leaveRemote'){showPanel('end');return;}
    if(name==='retry'){notify('success','重试已完成','模拟恢复结果');return;}
    if(name==='textInput'){layer.querySelector('#remoteText')?.focus();return;}
    if(name==='keyInput'){showPanel('textModeHelp');return;}
    if(name==='backToText'){stack.pop();drawPanel();layer.querySelector('#remoteText')?.focus();return;}
    if(name==='jumpSection'){closePanels();app.querySelector('.reader-body h3')?.scrollIntoView({block:'start'});return;}
    if(['openFile','shareFile','exportFile','runSync','shareText','checkUpdate','leftClick','rightClick','drag','scroll','sendText','demoDone','clearRecords'].includes(name)){closePanels();notify('success','操作回执示意','此原型没有执行真实操作');return;}
    showPanel(name);
  }
  document.addEventListener('click',event=>{const target=event.target.closest('button');if(!target)return;if(target.dataset.screen)changeScreen(target.dataset.screen);else if(target.dataset.size){phone.dataset.size=target.dataset.size;document.querySelectorAll('#sizes button').forEach(b=>b.setAttribute('aria-pressed',String(b===target)));document.getElementById('sizeLabel').textContent={portrait:'390 × 740 · 竖屏',landscape:'740 × 360 · 短横屏',small:'320 × 568 · 小屏'}[target.dataset.size];}else if(target.dataset.action)action(target.dataset.action,target);});
  app.addEventListener('input',event=>{if(event.target.id==='noteTitle')editorDraft.title=event.target.value;if(event.target.id==='noteBody')editorDraft.body=event.target.value;if(event.target.id==='noteSearch')app.querySelectorAll('#noteRows button').forEach(b=>b.hidden=!b.textContent.includes(event.target.value));});
  document.getElementById('dark').addEventListener('change',e=>{document.documentElement.dataset.theme=e.target.checked?'ocean-dark':'ocean';render();});
  document.getElementById('large').addEventListener('change',e=>phone.dataset.large=String(e.target.checked));
  document.getElementById('successDemo').addEventListener('click',()=>notify('success','操作已完成','短回执自动收起，保留内容空间。'));
  document.getElementById('errorDemo').addEventListener('click',()=>notify('error',screen==='files'?peer+'：文件未能发送':'操作未能完成','内容仍保留，可重试。'));
  document.addEventListener('visibilitychange',()=>document.hidden?stopTimer():resumeTimer());
  phone.addEventListener('pointerenter',stopTimer);phone.addEventListener('pointerleave',resumeTimer);
  phone.addEventListener('focusin',stopTimer);phone.addEventListener('focusout',event=>{if(!phone.contains(event.relatedTarget))resumeTimer();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&stack.length){event.preventDefault();stack.pop();drawPanel();}if(event.key==='Tab'&&stack.length){const items=[...layer.querySelectorAll('button,input,textarea')].filter(e=>!e.disabled);const first=items[0],last=items[items.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}});
  render();
})();
