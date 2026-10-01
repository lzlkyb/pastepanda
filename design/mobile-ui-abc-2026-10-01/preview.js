/* Offline design prototype. All connections, transfers and permissions are simulated. */
(() => {
  'use strict';
  const icon = (name, cls = '') => `<span class="${cls}" aria-hidden="true">${window.PANDA_ICONS[name] || window.PANDA_ICONS.CircleHelp}</span>`;
  const esc = (value) => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const specs = {
    A: { title: 'A · 原生分组', desc: '清楚的列表、安静的分组。把设备状态与操作层级放在第一位。', foot: '更适合多台设备与长期使用。与桌面共用主题色，触控层级更轻。' },
    B: { title: 'B · 设备卡片', desc: '常用电脑成为首页焦点。打开就能连接，设备详情也更有存在感。', foot: '更适合主要使用一两台电脑。设备主卡延续桌面详情区的视觉重心。' },
    C: { title: 'C · 轻玻璃', desc: '内容用清晰实底，导航轻轻浮起。材质集中在需要操作的地方。', foot: '局部玻璃与桌面胶囊呼应；列表不使用模糊，实施后需真机检查。' }
  };
  const devices = [
    {name:'工作室电脑',type:'Monitor',status:'可连接',online:true,hint:'上次局域网连接'},
    {name:'随身笔记本',type:'Laptop',status:'可连接',online:true,hint:'上次 P2P 直连'},
    {name:'家里的电脑',type:'Monitor',status:'暂不可达',online:false,hint:'可稍后重新检查'}
  ];
  const states = {};
  const root = document.getElementById('concepts');
  const query = new URLSearchParams(location.search);
  const focus = ['A','B','C'].includes(query.get('focus')) ? query.get('focus') : null;
  const variants = focus ? [focus] : ['A','B','C'];
  const pageNames = {devices:'设备',files:'文件',settings:'设置',session:'远控'};
  const currentTheme = () => document.documentElement.dataset.theme === 'midnight' ? '深色' : '浅色';
  if (focus) {
    root.classList.add('focused');
    const note = document.getElementById('focus-note');
    note.hidden = false;
    note.innerHTML = '<a href="?">返回三方案并排对比</a>单独体验可展开横屏远控。';
  }
  const action = (name, text, cls = 'secondary', extra = '') => `<button type="button" class="${cls}" data-action="${name}" ${extra}>${text}</button>`;
  const row = (d,i) => `<button type="button" class="device-row" data-action="device" data-device="${i}"><span class="device-icon ${d.online?'online':''}">${icon(d.type)}</span><span class="row-text"><strong>${esc(d.name)}</strong><p><span class="status-dot ${d.online?'':'offline'}"></span>${esc(d.status)} · ${esc(d.hint)}</p></span>${icon('ChevronRight','chevron')}</button>`;
  const header = (title, subtitle, add = false) => `<div class="page-head"><h3>${title}</h3>${add ? action('pair',`${icon('Plus')}添加`,'icon-button','aria-label="添加电脑"') : ''}</div><p class="page-sub">${subtitle}</p>`;
  function init() {
    variants.forEach(v => {
      states[v] = {page:'devices',scenario:'normal',picked:0,enabled:true,landscape:false,keyboard:false,viewOnly:false,audio:false,quality:'均衡',received:false,task:'active',taskProgress:38,sheet:null,pending:null,token:0,scroll:{},toastTimer:null,modifiers:new Set(),added:false};
      const section = document.createElement('article');
      section.className = 'concept'; section.dataset.variant = v;
      section.innerHTML = `<div class="concept-heading"><h2>${specs[v].title}</h2><a href="?focus=${v}" aria-label="单独体验方案 ${v}">单独体验 ${icon('ArrowUpRight')}</a></div><p class="concept-desc">${specs[v].desc}</p><div class="orientation-control" hidden><button data-action="orientation">${icon('RotateCw')} 横屏预览</button><span>示例画面 · 无远端连接</span></div><div class="phone phone-${v.toLowerCase()}" aria-label="方案 ${v} 手机预览"><div class="phone-status"><span>9:41</span><span class="island"></span><span class="status-symbols">${icon('Signal')}${icon('Wifi')}${icon('BatteryFull')}</span></div><div class="phone-main"></div><nav class="phone-nav" aria-label="手机主要导航"></nav><span class="home-indicator"></span></div><p class="concept-footer">${specs[v].foot}</p>`;
      root.append(section);
      section.addEventListener('click', e => onAction(v,e));
      render(v);
    });
    document.querySelectorAll('[data-icon]').forEach(el => el.innerHTML = window.PANDA_ICONS[el.dataset.icon]);
  }
  function devicePage(v,s) {
    const intro = v==='B' ? header('我的电脑','随时回到熟悉的工作空间。',true) : header('设备',v==='C'?'连接电脑，让工作随身。':'你的电脑，随时可达。',true);
    if (s.scenario==='empty') return intro + `<div class="empty-state"><span class="device-icon online">${icon('Monitor')}</span><h4>添加你的第一台电脑</h4><p>在电脑端打开远程电脑，<br>扫码或输入配对码，即可开始。</p>${action('pair',`${icon('Plus')}添加电脑`,'primary')}<p class="info-note">一次配对，之后可以直接连接。</p></div>`;
    const error = s.scenario==='error' ? `<div class="alert-banner" role="alert"><strong>暂时无法检查设备</strong><p>请检查网络，已配对的设备仍保留在这里。</p>${action('retry','重新检查','')}</div>` : '';
    const pending = s.pending ? waiting(s) : '';
    const list = devices.map(row).join('') + (s.added ? row({name:'新配对电脑',type:'Monitor',online:true,status:'可连接',hint:'刚刚配对'},3) : '');
    if(v==='B') return intro+error+pending+`<div class="feature-device"><div class="feature-tag"><span>${icon('Clock3')}常用设备 · 示例</span>${action('device',icon('Ellipsis'),'','data-device="0" aria-label="工作室电脑更多操作"')}</div><div class="monitor-art">${icon('Monitor')}</div><h4>工作室电脑</h4><p><span class="status-dot"></span>可连接 · 上次局域网连接</p>${action('connect',`${icon('MousePointer2')}远程控制`,'primary','data-device="0"')}${action('view',`${icon('Eye')}只看画面`,'secondary','data-device="0"')}</div><div class="section-label"><span>其他电脑</span>${action('refresh','重新检查','')}</div><div class="group">${devices.slice(1).map((d,i)=>row(d,i+1)).join('')}</div>`;
    if(v==='C') return intro+error+pending+`<div class="glass-status"><div><strong>远程通道已开启</strong><p>3 台已配对设备 · 示例</p></div><span>${icon('ShieldCheck')}</span></div><div class="quick-actions">${action('pair',`${icon('ScanLine')}添加电脑`,'')}${action('uno',`${icon('KeyRound')}无人值守`,'')}</div><div class="section-label"><span>已配对设备</span>${action('refresh','重新检查','')}</div><div class="group">${list}</div><p class="info-note">点设备选择远程控制、观看或传文件。</p>`;
    return intro+error+pending+`<div class="channel">${icon('ShieldCheck')}远程通道已开启</div><div class="section-label"><span>已配对设备</span>${action('refresh','重新检查','')}</div><div class="group">${list}</div><div class="section-label"><span>连接方式</span></div><div class="group">${action('pair',`${icon('ScanLine')}添加电脑`,'helper-link')}${action('uno',`${icon('KeyRound')}无人值守接入`,'helper-link')}</div><p class="info-note">设备状态来自最近一次连接检查。<br>点设备查看可用操作。</p>`;
  }
  function waiting(s){return `<div class="waiting-banner" role="status"><strong>正在连接${esc(s.pending)}…</strong><p>等待电脑端确认。你可以切换页面，请求会保留。</p>${action('cancel-connect','取消连接','secondary')}${action('complete-connect','模拟对方同意','helper-link')}</div>`;}
  function filePage(v,s) {
    const intro=header('文件',v==='B'?'文件在手机与电脑间，自然流动。':'不接管画面，也能互传文件。');
    if(s.scenario==='empty')return intro+`<div class="empty-state"><span class="device-icon online">${icon('FolderOpen')}</span><h4>先连接一台电脑</h4><p>完成配对后，可以在这里<br>发送、接收和查看传输进度。</p>${action('go-devices','前往设备','primary')}</div>`;
    return intro+`<button class="peer-select" data-action="choose-peer"><span class="device-icon online">${icon(devices[s.picked]?.type || 'Monitor')}</span><span class="row-text"><small>传输对象</small><strong>${esc(deviceName(s))}</strong></span>${icon('ChevronDown','chevron')}</button><div class="transfer-actions">${action('send',`${icon('Upload')}发到电脑`,'primary')}${action('pull',`${icon('Download')}从电脑取回`,'secondary')}</div><p class="info-note">取回时，电脑端需要确认并选择文件。</p><div class="section-label"><span>待接收</span><small>示例请求</small></div>${s.received ? `<div class="group">${action('reset-receive',`${icon('CircleCheck')}已处理接收请求 · 再次演示`,'helper-link')}</div>` : `<div class="receive-request"><strong>工作室电脑发来一个文件</strong><p>项目说明.pdf · 2.4 MB<br>接受后存入手机的接收目录。</p><div class="two-actions">${action('accept','接收','primary')}${action('deny','拒绝','secondary')}</div></div>`}<div class="section-label"><span>传输记录</span>${action('clear-files','清空已完成','')}</div>${task(s)}<div class="file-task completed-task"><div class="file-head"><span class="file-icon">${icon('FileImage')}</span><span class="row-text"><strong>界面参考.png</strong><p>接收 · 工作室电脑 · 1.8 MB</p></span><span class="task-done">${icon('CircleCheck')}</span></div></div><p class="info-note">${action('directory',`${icon('FolderOpen')}查看接收位置`,'helper-link')}</p>`;
  }
  function task(s){
    let state=s.scenario==='error'?'failed':s.task;
    const labels={active:`已发送 18.2 / 48 MB`,waiting:'等待电脑端确认',failed:'网络中断，文件未传完',done:'传输完成',cancelled:'已取消传输'};
    return `<div class="file-task"><div class="file-head"><span class="file-icon">${icon('FileArchive')}</span><span class="row-text"><strong>设计资料.zip</strong><p>发送 · ${esc(deviceName(s))} · 48 MB</p></span>${state==='done'?`<span class="task-done">${icon('CircleCheck')}</span>`:''}</div>${state==='active'?`<progress value="${s.taskProgress}" max="100" aria-label="设计资料.zip 传输进度"></progress><div class="progress-meta"><span>${labels.active}</span><span>${s.taskProgress}%</span></div><div class="two-actions">${action('progress','演示进度','small-action')}${action('cancel-task','取消传输','small-action')}</div>`:`<p class="info-note">${labels[state]}</p>${state==='failed'?action('retry-task','重新发送','small-action'):state==='waiting'?action('progress','模拟电脑确认','small-action'):action('reset-task','再次演示','small-action')}`}</div>`;
  }
  function settingsPage(v,s){
    return header('设置','简单设置，让连接更安心。')+`<div class="identity"><span class="device-icon online">${icon('Smartphone')}</span><div><strong>这台手机</strong><p>PastePanda 手机客户端</p></div></div><div class="section-label"><span>连接</span></div><div class="group"><div class="setting-row">${icon('Radio')}<span class="row-text"><strong>远程通道</strong><p>${s.enabled?'已开启，可发起连接':'已关闭，开启后可连接'}</p></span><button class="switch" data-action="toggle-channel" role="switch" aria-checked="${s.enabled}" aria-label="远程通道"></button></div>${settingEntry('history','Clock3','会话历史','查看最近的连接记录')}</div><div class="section-label"><span>体验</span><small>拟新增设置</small></div><div class="group">${settingEntry('appearance','SunMoon','外观',currentTheme()+'模式 · 与桌面同源')}${settingEntry('help','Hand','触摸操作指南','点击、长按与双指手势')}</div><div class="section-label"><span>高级</span></div><div class="group">${settingEntry('identity','Fingerprint','本机信息','设备身份与指纹')}${settingEntry('sandbox','FlaskConical','触摸演示','不连接远端，体验手势反馈')}</div><p class="settings-foot">PastePanda<br>连接你的电脑，延续你的工作。</p>`;
  }
  const settingEntry=(a,i,t,p)=>`<button class="setting-row" data-action="${a}">${icon(i)}<span class="row-text"><strong>${t}</strong><p>${p}</p></span>${icon('ChevronRight','chevron')}</button>`;
  function remoteDesktop(){return `<div class="remote-desktop"><div class="remote-top">${icon('PanelsTopLeft')}<strong>PastePanda</strong><span>知识库 · 工作笔记</span></div><div class="remote-work"><div class="remote-sidebar"><p>全部笔记</p><p>工作记录</p><p>项目资料</p><p>收件箱</p></div><div class="remote-paper"><h4>今天的工作计划</h4><p>整理项目资料，完善手机端体验。</p><div class="remote-rule"></div><p>✓ 完成设备连接与文件传输验证</p><p>✓ 对齐桌面端的主题与状态语言</p><p>□ 检查小屏、横屏和键盘体验</p><div class="remote-rule"></div><p>下一步：选择设计方向，确认交互细节。</p></div></div><span class="remote-tag">示例远程画面 · 非实时内容</span></div>`;}
  function sessionPage(v,s){return `<div class="session-heading"><strong>${esc(deviceName(s))}</strong><small>${s.viewOnly?'观看中':'控制中'} · 演示</small>${action('orientation',icon('RotateCw'),'','aria-label="切换横竖屏预览"')}</div><div class="session-viewport" data-action="remote-tap">${remoteDesktop()}</div><div class="session-tip">${s.viewOnly?'只看画面，不发送键鼠操作。':'单击选择 · 长按右键 · 双指滚动 / 缩放'}<br>${s.keyboard?'键盘仅展示布局，未调用系统输入法。':'工具触摸与远端画面点击分开处理。'}</div>${s.keyboard?keyboard(s):''}`;}
  function keyboard(s){return `<div class="mock-keyboard"><div class="keyboard-label">模拟键盘 · 原生输入法需真机验收</div><div class="modifier-bar">${['Ctrl','Alt','Shift','Win'].map(k=>action('modifier',k,s.modifiers.has(k)?'on':'',`data-key="${k}" aria-pressed="${s.modifiers.has(k)}"`)).join('')}${action('hide-keyboard',icon('ChevronDown'),'','aria-label="收起模拟键盘"')}</div><div class="keys-row">${'QWERTYUIOP'.split('').map(k=>`<span class="key">${k}</span>`).join('')}</div><div class="keys-row short">${'ASDFGHJKL'.split('').map(k=>`<span class="key">${k}</span>`).join('')}</div><div class="keys-row short">${'ZXCVBNM'.split('').map(k=>`<span class="key">${k}</span>`).join('')}</div><div class="keys-row space"><span class="key">123</span><span class="key">空格</span><span class="key">回车</span></div></div>`;}
  function toolbar(s,landscape=false){const items=[['keyboard','Keyboard','键盘',s.keyboard,s.viewOnly],['screen','Monitor','画面',false,false],['clipboard','Clipboard','剪贴板',false,s.viewOnly],['more','Ellipsis','更多',false,false]];return items.map(([a,i,t,on,disabled])=>action(a,`${icon(i)}<span>${t}</span>`,on?'on':'',`${disabled?'disabled':''} aria-label="${t}${disabled?'，观看模式不可用':''}"`)).join('');}
  function render(v){
    const s=states[v], section=root.querySelector(`[data-variant="${v}"]`),phone=section.querySelector('.phone'),main=phone.querySelector('.phone-main'),nav=phone.querySelector('.phone-nav');
    phone.classList.toggle('landscape',s.page==='session'&&s.landscape);
    section.querySelector('.orientation-control').hidden=s.page!=='session';
    section.querySelector('.orientation-control button').innerHTML=`${icon('RotateCw')}${s.landscape?'竖屏预览':'横屏预览'}`;
    main.classList.toggle('session-main',s.page==='session');
    const pages={devices:devicePage,files:filePage,settings:settingsPage,session:sessionPage};
    main.innerHTML=`<div class="page-entry ${s.page==='session'?'session-content':''}">${pages[s.page](v,s)}</div>`;
    if(s.page==='session'){main.innerHTML=pages.session(v,s);nav.classList.add('session-nav');nav.innerHTML=toolbar(s);nav.setAttribute('aria-label','远控工具栏');}
    else{nav.classList.remove('session-nav');nav.setAttribute('aria-label','手机主要导航');nav.innerHTML=[['devices','Monitor','设备'],['files','FolderOpen','文件'],['settings','Settings2','设置']].map(([p,i,l])=>`<button data-action="tab" data-tab="${p}" ${s.page===p?'aria-current="page"':''}>${icon(i)}<span>${l}</span></button>`).join('');}
    main.scrollTop=s.scroll[s.page]||0;
    phone.querySelectorAll('.global-notice,.session-toolbar-landscape,.landscape-reveal').forEach(el=>el.remove());
    if(s.pending&&s.page!=='devices'&&s.page!=='session')phone.insertAdjacentHTML('beforeend',`<div class="global-notice" role="status">${icon('Monitor')}<span>正在连接${esc(s.pending)}</span>${action('go-devices','查看','')}</div>`);
    if(s.page==='session'&&s.landscape)phone.insertAdjacentHTML('beforeend',s.capsuleHidden?action('reveal-tools','显示工具','landscape-reveal'):`<nav class="session-toolbar-landscape" aria-label="横屏远控工具">${toolbar(s,true)}${action('hide-tools',icon('ChevronUp'),'','aria-label="收起横屏工具栏"')}</nav>`);
    updatePageControls();
  }
  function updatePageControls(){const all=variants.map(v=>states[v]?.page);document.querySelectorAll('#page-controls button').forEach(b=>b.setAttribute('aria-pressed',String(all.every(p=>p===b.dataset.page))));}
  function goto(v,page){const s=states[v],main=root.querySelector(`[data-variant="${v}"] .phone-main`);s.scroll[s.page]=main.scrollTop;closeSheet(v,true);s.page=page;render(v);}
  function deviceName(s){return devices[s.picked]?.name || '新配对电脑';}
  function getPhone(v){return root.querySelector(`[data-variant="${v}"] .phone`);}
  function sheet(v,title,content){
    closeSheet(v,true);const s=states[v],phone=getPhone(v);s.sheet=title;s.returnFocus=document.activeElement;
    phone.insertAdjacentHTML('beforeend',`<div class="sheet-layer"><section class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="sheet-handle" aria-hidden="true"></div><div class="sheet-head"><h4>${esc(title)}</h4>${action('close-sheet','关闭','icon-button')}</div>${content}</section></div>`);
    phone.querySelector('.sheet-layer').addEventListener('click',e=>{if(e.target.classList.contains('sheet-layer'))closeSheet(v);});
    const handle=phone.querySelector('.sheet-handle');let y=null;
    handle.parentElement.addEventListener('pointerdown',e=>{if(e.target===handle)y=e.clientY;});
    handle.parentElement.addEventListener('pointerup',e=>{if(y!==null&&e.clientY-y>45)closeSheet(v);y=null;});
    phone.querySelector('.sheet-head button').focus({preventScroll:true});
  }
  function closeSheet(v,instant=false){
    const s=states[v],layer=getPhone(v)?.querySelector('.sheet-layer');s.sheet=null;
    if(!layer)return;
    if(instant)layer.remove();else{layer.classList.add('layer-out');layer.querySelector('.sheet').classList.add('close-animation');setTimeout(()=>layer.remove(),200);}
    if(s.returnFocus?.isConnected)s.returnFocus.focus({preventScroll:true});
  }
  function deviceSheet(v,index){const s=states[v];s.picked=index;const d=devices[index]||{name:'新配对电脑',type:'Monitor',online:true,status:'可连接',hint:'刚刚配对'};
    sheet(v,'设备操作',`<span class="device-icon online">${icon(d.type)}</span><h4 class="sheet-device-name">${esc(d.name)}</h4><p class="sheet-device-status"><span class="status-dot ${d.online?'':'offline'}"></span>${d.status} · ${d.hint}</p>${action('connect',`${icon('MousePointer2')}远程控制`,'primary')}${action('view',`${icon('Eye')}只看画面`,'secondary')}${action('device-files',`${icon('Upload')}传文件`,'secondary')}<div class="sheet-links">${action('uno',`${icon('KeyRound')}无人值守接入${icon('ChevronRight')}`,'')}${action('forget',`${icon('Unlink')}解除配对`,'destructive')}</div>`);
  }
  function toast(v,text){const phone=getPhone(v),s=states[v];clearTimeout(s.toastTimer);phone.querySelector('.toast')?.remove();phone.insertAdjacentHTML('beforeend',`<div class="toast" role="status">${icon('CircleCheck')}<span>${esc(text)}</span>${action('dismiss-toast',icon('X'),'','aria-label="关闭提示"')}</div>`);s.toastTimer=setTimeout(()=>phone.querySelector('.toast')?.remove(),4000);}
  function pair(v){sheet(v,'添加电脑',`<p>在电脑端打开“远程电脑”，选择配对；扫描二维码，或输入电脑上的 8 位配对码。</p>${action('scan',`${icon('ScanLine')}扫一扫`,'primary')}<label for="pair-code-${v}">电脑上的配对码</label><input id="pair-code-${v}" class="code-input" inputmode="numeric" autocomplete="off" maxlength="8" placeholder="输入 8 位数字" aria-describedby="pair-hint-${v}"><p class="info-note" id="pair-hint-${v}">演示码：12345678。不会发起真实配对。</p>${action('pair-submit','配对电脑','primary')}<div class="sheet-status" hidden role="status"></div>${action('own-code','出示本机配对码','helper-link')}`);}
  function connect(v,view=false){const s=states[v];if(!s.enabled){closeSheet(v);toast(v,'远程通道已关闭，请在设置中开启');return;}if(s.picked===2){sheet(v,'暂时无法连接',`<p>家里的电脑暂不可达，请确认电脑已开机并启用远程通道。</p>${action('refresh','重新检查','primary')}${action('close-sheet','稍后再试','secondary')}`);return;}s.viewOnly=view;s.pending=deviceName(s);s.scenario='normal';goto(v,'devices');toast(v,'连接请求已发出，等待电脑确认（演示）');}
  function onAction(v,e){
    const target=e.target.closest('[data-action]');if(!target||target.disabled)return;const s=states[v],a=target.dataset.action;
    if(target.dataset.device!==undefined)s.picked=Number(target.dataset.device);
    switch(a){
      case 'tab':goto(v,target.dataset.tab);break;
      case 'go-devices':goto(v,'devices');break;
      case 'device':deviceSheet(v,s.picked);break;
      case 'pair':pair(v);break;
      case 'close-sheet':closeSheet(v);break;
      case 'connect':connect(v);break;
      case 'view':connect(v,true);break;
      case 'cancel-connect':s.pending=null;s.token++;render(v);toast(v,'连接请求已取消');break;
      case 'complete-connect':s.pending=null;s.page='session';s.keyboard=false;render(v);toast(v,'已进入远控演示');break;
      case 'device-files':goto(v,'files');break;
      case 'retry':case 'refresh':s.scenario='normal';closeSheet(v,true);render(v);toast(v,'设备检查已更新（演示）');break;
      case 'uno':sheet(v,'无人值守接入',`<p>输入电脑端生成的接入码与口令。权限与有效期由电脑端决定。</p><label for="uno-code-${v}">接入码</label><input id="uno-code-${v}" class="code-input" placeholder="输入接入码" autocomplete="off"><label for="uno-pass-${v}">访问口令</label><input id="uno-pass-${v}" type="password" class="code-input" placeholder="输入口令" autocomplete="off">${action('uno-submit','连接电脑','primary')}<p class="info-note">仅模拟输入流程，不保存口令、不发起连接。</p><div class="sheet-status" hidden role="status"></div>`);break;
      case 'uno-submit':{const inputs=getPhone(v).querySelectorAll('.sheet input'),status=getPhone(v).querySelector('.sheet-status');status.hidden=false;if([...inputs].some(i=>!i.value.trim())){status.className='sheet-status error';status.textContent='请填写接入码与访问口令。';}else{closeSheet(v,true);connect(v);}break;}
      case 'forget':sheet(v,'解除配对？',`<p>解除与“${esc(deviceName(s))}”的配对后，下次连接需要重新配对。</p>${action('confirm-forget','解除配对','danger')}${action('close-sheet','保留设备','secondary')}<p class="info-note">此设计稿不会更改真实设备。</p>`);break;
      case 'confirm-forget':closeSheet(v);toast(v,'已模拟解除配对，示例列表保留供比较');break;
      case 'scan':sheet(v,'扫一扫',`<div class="scan-stage">${icon('ScanLine')}</div><p>将电脑端的配对二维码放入取景框。</p>${action('scan-done','模拟识别二维码','primary')}${action('scan-denied','模拟权限被拒绝','secondary')}${action('pair','改用配对码','helper-link')}<p class="info-note">取景框为示意，不访问摄像头。</p>`);break;
      case 'scan-denied':sheet(v,'摄像头未获授权',`<p>无法使用扫一扫。你仍可以输入电脑上的配对码完成配对。</p>${action('pair','输入配对码','primary')}${action('scan','返回扫码预览','secondary')}`);break;
      case 'scan-done':s.added=true;s.scenario='normal';closeSheet(v,true);render(v);toast(v,'已模拟添加“新配对电脑”');break;
      case 'pair-submit':{const input=getPhone(v).querySelector('.code-input'),status=getPhone(v).querySelector('.sheet-status');status.hidden=false;if(!/^\d{8}$/.test(input.value)){status.className='sheet-status error';status.textContent='请输入完整的 8 位数字配对码。';input.focus();}else{status.className='sheet-status';status.innerHTML=`等待电脑端确认（演示）${action('scan-done','模拟电脑确认','helper-link')}`;target.disabled=true;}break;}
      case 'own-code':sheet(v,'本机配对码',`<p>示例配对码仅供比较布局，不能用于真实配对。</p><div class="code-input">87654321</div><p class="info-note">示例有效期：60 秒。真实有效期由后端提供。</p>${action('pair','返回输入电脑码','secondary')}`);break;
      case 'choose-peer':sheet(v,'选择电脑',devices.map((d,i)=>`<div class="check-row">${action('pick-peer',`${esc(d.name)}${s.picked===i?icon('Check'):''}`,'',`data-device="${i}"`)}</div>`).join(''));break;
      case 'pick-peer':closeSheet(v,true);render(v);break;
      case 'send':sheet(v,'发文件到电脑',`<p>将发送到“${esc(deviceName(s))}”。正式版本将使用手机系统文件选择器。</p><div class="group"><div class="setting-row">${icon('FileArchive')}<span class="row-text"><strong>设计资料.zip</strong><p>48 MB · 示例文件</p></span>${icon('Check')}</div></div>${action('send-confirm','发送示例文件','primary')}<p class="info-note">不读取手机文件，仅模拟传输流程。</p>`);break;
      case 'send-confirm':s.task='waiting';s.taskProgress=0;s.scenario='normal';closeSheet(v,true);render(v);toast(v,'文件已准备，等待电脑端确认（演示）');break;
      case 'pull':sheet(v,'从电脑取回',`<p>向“${esc(deviceName(s))}”发出请求。电脑端需要确认并选择要发送的文件。</p>${action('pull-confirm','发出取回请求','primary')}<p class="info-note">无需接管电脑画面。此处不提供远端文件浏览器。</p>`);break;
      case 'pull-confirm':closeSheet(v,true);toast(v,'已模拟发出取回请求，请在电脑端选择文件');break;
      case 'accept':case 'deny':s.received=true;render(v);toast(v,a==='accept'?'已模拟接收“项目说明.pdf”':'已拒绝本次示例请求');break;
      case 'reset-receive':s.received=false;render(v);break;
      case 'progress':s.scenario='normal';s.task='active';s.taskProgress=Math.min(100,s.taskProgress+31);if(s.taskProgress===100)s.task='done';render(v);break;
      case 'cancel-task':s.task='cancelled';render(v);toast(v,'示例传输已取消');break;
      case 'retry-task':case 'reset-task':s.scenario='normal';s.task='active';s.taskProgress=38;render(v);toast(v,'已重新开始示例传输');break;
      case 'clear-files':getPhone(v).querySelector('.completed-task')?.remove();toast(v,'已清空本页已完成记录（演示）');break;
      case 'directory':sheet(v,'文件接收位置',`<p>收到的文件存入手机应用的接收目录，正式路径由应用提供。</p><div class="sheet-status">应用文件 / 接收文件（示意）</div><p>实际文件访问方式需要根据 Android 版本与存储权限验证。</p>${action('close-sheet','知道了','primary')}`);break;
      case 'toggle-channel':s.enabled=!s.enabled;render(v);toast(v,s.enabled?'远程通道已开启（演示）':'远程通道已关闭（演示）');break;
      case 'appearance':sheet(v,'外观',`<p>沿用桌面主题的品牌色与状态色。</p><div class="check-row">${action('theme-light',`浅色${currentTheme()==='浅色'?icon('Check'):''}`,'')}</div><div class="check-row">${action('theme-dark',`深色${currentTheme()==='深色'?icon('Check'):''}`,'')}</div><p class="info-note">对比时同步切换三套方案。移动端外观设置为拟新增。</p>`);break;
      case 'theme-light':case 'theme-dark':closeSheet(v,true);setTheme(a==='theme-dark');break;
      case 'history':sheet(v,'会话历史',`<div class="group"><div class="setting-row"><span class="row-text"><strong>连到工作室电脑</strong><p>远程控制 · 今天 09:12 · 18 分钟</p></span></div><div class="setting-row"><span class="row-text"><strong>连到随身笔记本</strong><p>只看画面 · 昨天 21:30 · 6 分钟</p></span></div></div><p class="info-note">时间与记录为示例数据。</p>${action('clear-history','清空会话历史','danger')}`);break;
      case 'clear-history':sheet(v,'清空会话历史？',`<p>清空后无法恢复，但不会解除设备配对。</p>${action('confirm-clear','清空历史','danger')}${action('close-sheet','取消','secondary')}`);break;
      case 'confirm-clear':sheet(v,'会话历史',`<div class="empty-state"><h4>还没有会话记录</h4><p>下一次连接后，记录会出现在这里。</p></div><p class="info-note">清空仅作用于本次演示。</p>`);break;
      case 'help':sheet(v,'触摸操作指南',`<div class="group">${['单击：远端左键点击','双击：远端双击','长按：右键；移动可拖拽','双指平移：滚动远端页面','双指捏合：缩放本地视野'].map(t=>`<div class="setting-row"><span class="row-text"><strong>${t}</strong></span></div>`).join('')}</div><p class="info-note">手势沿用现有实现。此设计稿只展示点击定位反馈，不连接远端。</p>${action('sandbox','进入触摸演示','primary')}`);break;
      case 'identity':sheet(v,'本机信息',`<div class="group"><div class="setting-row"><span class="row-text"><strong>设备名称</strong><p>这台手机</p></span></div><div class="setting-row"><span class="row-text"><strong>身份指纹</strong><p>…A8F2 71C9 · 示例</p></span></div></div><p class="info-note">真实身份由现有客户端提供，不在设计稿中读取。</p>`);break;
      case 'sandbox':s.pending=null;s.viewOnly=false;goto(v,'session');toast(v,'触摸演示：点击画面可查看本地定位反馈');break;
      case 'orientation':s.landscape=!s.landscape;render(v);if(s.landscape&&!focus)toast(v,'并排模式为缩小示意；单独体验可查看宽横屏');break;
      case 'keyboard':if(!s.viewOnly){s.keyboard=!s.keyboard;render(v);}break;
      case 'hide-keyboard':s.keyboard=false;render(v);break;
      case 'modifier':{const k=target.dataset.key;s.modifiers.has(k)?s.modifiers.delete(k):s.modifiers.add(k);target.classList.toggle('on',s.modifiers.has(k));target.setAttribute('aria-pressed',s.modifiers.has(k));break;}
      case 'screen':sheet(v,'画面显示',`${action('fit','适应屏幕','primary')}${action('actual','实际大小','secondary')}<p class="info-note">设计稿仅演示反馈，实际画面缩放沿用现有视野组件。</p>`);break;
      case 'fit':case 'actual':closeSheet(v);toast(v,a==='fit'?'已选择适应屏幕（演示）':'已选择实际大小（演示）');break;
      case 'clipboard':sheet(v,'剪贴板',`<p>选择要传送文字的方向。</p>${action('clip-push',`${icon('ArrowUp')}推到电脑`,'primary')}${action('clip-pull',`${icon('ArrowDown')}取到手机`,'secondary')}<p class="info-note">设计稿不读取系统剪贴板。</p>`);break;
      case 'clip-push':case 'clip-pull':closeSheet(v);toast(v,a==='clip-push'?'已模拟将文字推到电脑':'已模拟从电脑取回文字');break;
      case 'more':sheet(v,'会话选项',`<div class="group">${settingEntry('quality','SlidersHorizontal','画质',s.quality)}<div class="setting-row">${icon('Volume2')}<span class="row-text"><strong>电脑声音</strong><p>默认关闭，避免突然外放</p></span><button class="switch" data-action="audio" role="switch" aria-checked="${s.audio}" aria-label="电脑声音"></button></div></div><div class="sheet-links">${action('help',`${icon('Hand')}触摸操作指南${icon('ChevronRight')}`,'')}${action('end-session',`${icon('Power')}断开连接`,'destructive')}</div>`);break;
      case 'quality':sheet(v,'画质',`<p>根据网络情况选择。设计稿不改变真实编码参数。</p>${['清晰','均衡','流畅'].map(q=>`<div class="check-row">${action('pick-quality',`${q}${s.quality===q?icon('Check'):''}`,'',`data-quality="${q}"`)}</div>`).join('')}`);break;
      case 'pick-quality':s.quality=target.dataset.quality;closeSheet(v);toast(v,`画质已设为${s.quality}（演示）`);break;
      case 'audio':s.audio=!s.audio;target.setAttribute('aria-checked',s.audio);toast(v,s.audio?'已模拟开启电脑声音':'已模拟关闭电脑声音');break;
      case 'end-session':sheet(v,'断开连接？',`<p>你将离开“${esc(deviceName(s))}”的画面，电脑不会关机。</p>${action('confirm-end','断开连接','danger')}${action('close-sheet','继续会话','secondary')}`);break;
      case 'confirm-end':s.keyboard=false;s.landscape=false;goto(v,'devices');toast(v,'已结束远控演示');break;
      case 'hide-tools':s.capsuleHidden=true;render(v);break;
      case 'reveal-tools':s.capsuleHidden=false;render(v);break;
      case 'dismiss-toast':getPhone(v).querySelector('.toast')?.remove();break;
      case 'remote-tap':{const el=target,r=el.getBoundingClientRect(),ring=document.createElement('span');ring.className='tap-ring';ring.style.left=`${e.clientX-r.left-12}px`;ring.style.top=`${e.clientY-r.top-12}px`;el.append(ring);setTimeout(()=>ring.remove(),320);break;}
    }
  }
  function setTheme(dark){document.documentElement.dataset.theme=dark?'midnight':'ocean';document.getElementById('theme-toggle').innerHTML=`${icon(dark?'Sun':'Moon')}<span>${dark?'浅色模式':'深色模式'}</span>`;variants.forEach(v=>{if(states[v].page==='settings')render(v);});}
  document.getElementById('theme-toggle').addEventListener('click',()=>setTheme(currentTheme()==='浅色'));
  document.getElementById('page-controls').addEventListener('click',e=>{const b=e.target.closest('[data-page]');if(b)variants.forEach(v=>{states[v].landscape=false;goto(v,b.dataset.page);});});
  document.getElementById('scenario').addEventListener('change',e=>variants.forEach(v=>{const s=states[v];s.scenario=e.target.value;s.pending=s.scenario==='waiting'?'工作室电脑':null;s.viewOnly=false;render(v);}));
  document.getElementById('phone-width').addEventListener('change',e=>{document.documentElement.style.setProperty('--phone-width',`${e.target.value}px`);root.querySelectorAll('.phone').forEach(p=>p.classList.toggle('wide',e.target.value==='430'));});
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'){const v=variants.find(v=>states[v].sheet)||variants.find(v=>states[v].keyboard)||variants.find(v=>states[v].page==='session');if(!v)return;e.preventDefault();if(states[v].sheet)closeSheet(v);else if(states[v].keyboard){states[v].keyboard=false;render(v);}else sheet(v,'断开连接？',`<p>返回设备页会结束本次远控演示。</p>${action('confirm-end','断开并返回','danger')}${action('close-sheet','继续会话','secondary')}`);}
    if(e.key==='Tab'){const layer=document.activeElement.closest('.sheet-layer');if(!layer)return;const controls=[...layer.querySelectorAll('button:not(:disabled),input,a[href]')],first=controls[0],last=controls.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}
  });
  init();
})();
