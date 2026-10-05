const icons = window.PANDA_ICONS;
icons.History = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></svg>';
icons.Palette = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1.5-3.3 1.5 1.5 0 0 1 1.1-2.7H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8Z"/><circle cx="7.5" cy="10" r=".7"/><circle cx="10" cy="6.8" r=".7"/><circle cx="14" cy="6.8" r=".7"/><circle cx="17" cy="10" r=".7"/></svg>';
icons.Computer = '<svg viewBox="0 0 64 64" fill="currentColor" aria-hidden="true"><rect x="3" y="8" width="58" height="38" rx="4"/><rect x="7" y="12" width="50" height="29" rx="1" fill="var(--section-bg)"/><path d="M27 46h10l3 10H24Z"/><rect x="17" y="56" width="30" height="3" rx="1.5"/></svg>';
icons.Tablet = '<svg viewBox="0 0 64 64" fill="currentColor" aria-hidden="true"><rect x="4" y="12" width="56" height="40" rx="5"/><rect x="9" y="16" width="46" height="32" rx="2" fill="var(--section-bg)"/><circle cx="6.5" cy="32" r="1" fill="var(--section-bg)"/></svg>';
icons.ChevronRight = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
const icon = name => icons[name] || icons.Monitor;
const plans = [['a','A · 经典磨砂','导航轻微透光，内容全实底。稳重易读，升级幅度较小。'],['b','B · 分层毛玻璃 · 推荐','导航轻透，弹层厚透，内容清晰。质感与操控的平衡。'],['c','C · 通透玻璃','导航透光更强，边缘高光更明显。视觉突出，需更多对比度与性能验证。']];
const comparison = document.getElementById('comparison');
comparison.innerHTML = plans.map(([id,title,text])=>`<article class="variant"><h2>${title}</h2><p>${text}</p><div class="phone ${id}" data-plan="${id}"><header class="top glass"><strong>设备</strong><button data-act="add">添加</button></header><div class="body"></div><nav class="nav glass" aria-label="${title} 页面导航" data-current="devices"><span class="selection" aria-hidden="true"></span><button data-route="devices">${icon('Monitor')}设备</button><button data-route="files">${icon('FolderOpen')}文件</button><button data-route="settings">${icon('Settings2')}设置</button></nav><div class="overlay" hidden><section class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title-${id}" tabindex="-1"><button class="handle" aria-label="拖动收起面板"><span></span></button><header><h3 id="sheet-title-${id}"></h3><button data-act="close">关闭</button></header><div class="sheet-body"></div></section></div></div></article>`).join('');
const row = (name, detail, act, glyph='Computer')=>`<button class="row" data-act="${act}">${icon(glyph)}<span><strong>${name}</strong><small>${detail}</small></span>${icons.ChevronRight.replace('<svg ', '<svg class="chevron" ')}</button>`;
const content = {
  devices: `<p>连接电脑，让工作随身。</p><div class="channel"><div><strong>远程通道已开启</strong><small>3 台已配对设备 · 示例</small></div>${icon('ShieldCheck')}</div><div class="actions"><button data-act="add">${icon('ScanLine')}添加电脑</button><button data-act="unattended">${icon('KeyRound')}无人值守</button></div><div class="section-label">已配对设备</div><div class="group">${row('工作电脑','电脑 · 可连接','device')}${row('家里的电脑','电脑 · 最近在线','device','Laptop')}${row('iPad Air','平板 · 类型示例','device','Tablet')}</div><div class="section-label">连接提示</div><p>点击设备查看控制、只看与文件操作。设备名称和类型继续复用现有识别规则。</p>`,
  files: `<p>把文件送到需要的地方。</p><div class="section-label">目标设备</div><div class="group">${row('工作电脑','电脑 · 点击切换','target')}</div><div class="actions"><button class="primary" data-act="send">${icon('FolderOpen')}选择文件发送</button></div><div class="section-label">传输任务 · 示例数据</div><div class="group file-task"><strong>产品说明.pdf</strong><p>正在发送 · 示例进度 62%</p><div class="progress" aria-label="示例进度 62%"><span></span></div><button data-act="cancel">取消传输</button></div><div class="section-label">文件接收</div><div class="group">${row('接收位置','保留现有目录与权限规则','receive','FolderOpen')}</div>`,
  settings: `<p>按自己的习惯使用 PastePanda。</p><div class="section-label">连接与记录</div><div class="group">${row('远程通道','已开启 · 示例状态','channel','ShieldCheck')}${row('会话历史','查看连接时间和时长','history','History')}</div><div class="section-label">使用偏好</div><div class="group">${row('外观','跟随系统','appearance','Palette')}${row('手势使用指南','点按、长按、滚动与缩放','guide','MousePointer2')}${row('触摸演示','测试画面，不连接电脑','control','MousePointer2')}</div><p class="caption">减少动态效果与减少透明度优先尊重系统。</p>`,
  control: `<p>工作电脑 · 控制中（示例）</p><div class="notice">触控板 · 划动移动指针</div><div class="screen-demo"><header>文件管理器<span>电脑画面示意</span></header><strong>项目资料</strong><p>产品设计</p><p>手机端交互规划</p></div><div class="control-tools"><button data-act="click">左键</button><button data-act="right">右键</button><button data-act="drag">拖拽</button><button data-act="scroll">滚动</button></div><p class="caption">画面层保持清晰。长按、双指识别沿用 B 方案；本稿不注入远端输入。</p>`
};
function route(phone,page){
  const previous=phone.dataset.page;
  if(previous===page)return;
  phone.dataset.page=page;
  phone.querySelector('.top strong').textContent={devices:'设备',files:'文件',settings:'设置',control:'工作电脑'}[page];
  const action=phone.querySelector('.top button');action.textContent=page==='devices'?'添加':page==='control'?'画面':'更多';action.dataset.act=page==='devices'?'add':page==='control'?'view':'more';
  const body=phone.querySelector('.body');
  const interrupted=phone.pageAnimation?.playState==='running';
  const position=interrupted?getComputedStyle(body).transform:null;
  const opacity=interrupted?getComputedStyle(body).opacity:'.88';
  phone.pageAnimation?.cancel();
  body.innerHTML=content[page];body.scrollTop=0;
  phone.querySelector('.top').classList.remove('scrolled');
  if(previous&&!PandaMotion.reduced.matches){
    const direction=['devices','files','settings','control'].indexOf(page)>['devices','files','settings','control'].indexOf(previous)?1:-1;
    phone.pageAnimation=body.animate([{transform:position||`translateX(${direction*12}px)`,opacity},{transform:'translateX(0)',opacity:1}],{duration:200,easing:'cubic-bezier(.2,0,0,1)'});
  }
  const nav=phone.querySelector('.nav');nav.dataset.current=page;
  if(page==='control'){
    phone.selectionMotion?.stop();
    nav.innerHTML=`<button data-act="pointer">${icon('MousePointer2')}触控板</button><button data-act="keyboard">${icon('Keyboard')}键盘</button><button data-act="view">${icon('Monitor')}画面</button><button data-act="more">${icon('Ellipsis')}更多</button>`;
  }
  else {
    if(!nav.querySelector('.selection'))nav.innerHTML=`<span class="selection" aria-hidden="true"></span><button data-route="devices">${icon('Monitor')}设备</button><button data-route="files">${icon('FolderOpen')}文件</button><button data-route="settings">${icon('Settings2')}设置</button>`;
    nav.querySelectorAll('[data-route]').forEach(button=>{if(button.dataset.route===page)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');});
    const selection=nav.querySelector('.selection');
    if(phone.selectionElement!==selection){
      phone.selectionElement=selection;
      phone.selectionMotion=PandaMotion.spring(0,value=>selection.style.transform=`translateX(${value}%)`);
    }
    phone.selectionMotion.move(['devices','files','settings'].indexOf(page)*100);
  }
}
function close(phone,immediate=false,velocity){
  const overlay=phone.querySelector('.overlay');if(overlay.hidden)return;
  phone.sheetClosing=true;phone.classList.remove('sheet-open');
  const finish=()=>{overlay.hidden=true;phone.sheetClosing=false;phone.restoreFocus?.focus();};
  const target=phone.querySelector('.sheet').offsetHeight+16;
  if(immediate){phone.sheetMotion.set(target);finish();}
  else phone.sheetMotion.move(target,velocity,finish);
}
function open(phone,title,html){
  const overlay=phone.querySelector('.overlay'),sheet=phone.querySelector('.sheet');
  const fresh=overlay.hidden;
  if(fresh)phone.restoreFocus=document.activeElement;
  phone.sheetClosing=false;
  sheet.querySelector('h3').textContent=title;sheet.querySelector('.sheet-body').innerHTML=html;
  overlay.hidden=false;
  if(fresh)phone.sheetMotion.set(sheet.offsetHeight+16);
  phone.classList.add('sheet-open');phone.sheetMotion.move(0);sheet.focus();
}
const primary=(label,act)=>`<button class="primary" data-act="${act}">${label}</button>`;
document.querySelectorAll('.phone').forEach(phone=>{
  const sheet=phone.querySelector('.sheet');
  const scrim=document.createElement('div');scrim.className='scrim';scrim.setAttribute('aria-hidden','true');phone.querySelector('.overlay').prepend(scrim);
  phone.sheetMotion=PandaMotion.spring(0,value=>sheet.style.transform=`translateY(${Math.max(0,value)}px)`);
  route(phone,'devices');
  phone.querySelector('.body').onscroll=e=>phone.querySelector('.top').classList.toggle('scrolled',e.currentTarget.scrollTop>24);
  phone.onclick=e=>{
    const button=e.target.closest('button');
    if(e.target===phone.querySelector('.overlay')||e.target===scrim){close(phone);return;}
    if(!button)return;
    if(button.dataset.route){close(phone,true);route(phone,button.dataset.route);return;}
    const act=button.dataset.act;
    if(!act)return;
    if(act==='close'){close(phone);return;}
    if(act==='control'){close(phone,true);route(phone,'control');return;}
    if(act==='add')open(phone,'添加电脑',`<p>电脑打开配对二维码，用手机扫一扫。也可输入对方 8 位配对码。</p>${primary('扫一扫 · 本地演示','scan')}<button data-act="code">输入配对码</button><p>扫码能力沿用现有实现；本稿不请求摄像头。</p>`);
    else if(act==='device')open(phone,'工作电脑',`<p>电脑 · 可连接（示例）。名称与设备类型保持常驻。</p>${primary('连接并控制','control')}<button data-act="control">只看 · 外观演示</button><button data-route="files">传文件</button>`);
    else if(act==='target')open(phone,'选择目标设备',`${row('工作电脑','电脑 · 示例','picked')}${row('家里的电脑','电脑 · 示例','picked','Laptop')}`);
    else if(act==='view')open(phone,'画面与画质','<button data-act="done">适应屏幕</button><button data-act="done">回到指针</button><button data-act="done">画质 · 均衡</button><p>弹层偏厚，内容层不模糊。</p>');
    else if(act==='appearance')open(phone,'外观','<button data-act="light">浅色</button><button data-act="dark">深色</button><button data-act="done">跟随系统 · 示例</button>');
    else if(act==='keyboard')open(phone,'电脑键盘','<p>沿用草稿保留与提交反馈。真正软键盘需要手机验证，本稿展示工具层材质。</p><button data-act="done">收起键盘</button>');
    else if(act==='drag'||act==='scroll') {button.setAttribute('aria-pressed',button.getAttribute('aria-pressed')!=='true');button.textContent=act==='drag'?(button.getAttribute('aria-pressed')==='true'?'释放拖拽':'拖拽'):(button.getAttribute('aria-pressed')==='true'?'退出滚动':'滚动');}
    else if(act==='dark'||act==='light'){document.documentElement.dataset.theme=act==='dark'?'midnight':'ocean';close(phone);}
    else if(act==='done'||act==='picked')close(phone);
    else open(phone,{unattended:'无人值守',history:'会话历史',guide:'手势使用指南',receive:'接收位置',pointer:'操作方式',scan:'扫一扫',code:'输入配对码',send:'选择文件',cancel:'取消传输',channel:'远程通道',more:'更多',click:'左键',right:'右键'}[act]||'操作反馈','<p>这是整体风格提案。此入口的业务、权限与结果仍使用现有逻辑。</p><button data-act="done">知道了</button>');
  };
  let drag=null;const handle=phone.querySelector('.handle');
  handle.setAttribute('aria-label','向下拖动或点击收起面板');
  handle.onpointerdown=e=>{
    if(drag||e.button!==0)return;
    const current=phone.sheetMotion.stop();
    drag={id:e.pointerId,start:e.clientY,origin:Math.max(0,current.position),position:Math.max(0,current.position),last:e.timeStamp,velocity:0,moved:0};
    phone.sheetClosing=false;phone.classList.add('sheet-open');handle.setPointerCapture(e.pointerId);
  };
  handle.onpointermove=e=>{
    if(!drag||drag.id!==e.pointerId)return;
    const next=Math.max(0,drag.origin+e.clientY-drag.start),elapsed=e.timeStamp-drag.last;
    if(elapsed>0)drag.velocity=(next-drag.position)/elapsed*1000;
    drag.position=next;drag.last=e.timeStamp;drag.moved=Math.max(drag.moved,Math.abs(e.clientY-drag.start));
    phone.sheetMotion.set(next);
  };
  handle.onpointerup=e=>{
    if(!drag||drag.id!==e.pointerId)return;
    const current=drag;drag=null;
    const velocity=e.timeStamp-current.last>80?0:current.velocity;
    if(current.moved<4||current.position>80||(current.position>16&&velocity>600))close(phone,false,velocity);
    else phone.sheetMotion.move(0,velocity);
  };
  const cancelDrag=()=>{if(!drag)return;drag=null;phone.sheetMotion.move(0,0);};
  handle.onpointercancel=cancelDrag;handle.onlostpointercapture=cancelDrag;
  handle.onclick=e=>{if(e.detail===0)close(phone);};
  window.addEventListener('blur',cancelDrag);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)cancelDrag();});
});
document.querySelectorAll('.preview-tools [data-page]').forEach(button=>button.onclick=()=>{document.querySelectorAll('.preview-tools [data-page]').forEach(b=>b.setAttribute('aria-pressed',b===button));document.querySelectorAll('.phone').forEach(phone=>{close(phone,true);route(phone,button.dataset.page);});});
document.getElementById('theme').onclick=e=>{const dark=document.documentElement.dataset.theme!=='midnight';document.documentElement.dataset.theme=dark?'midnight':'ocean';e.currentTarget.textContent=dark?'浅色外观':'深色外观';};
document.getElementById('motion-sheet').onclick=()=>{
  const phone=document.querySelector('.phone.b');
  if(phone.querySelector('.overlay').hidden||phone.sheetClosing)open(phone,'连续动效体验','<p>拖动顶部手柄：短距离松手会回弹，快速向下甩动会接着收起。动画途中再抓住，也能直接接管。</p><p>再次点击上方“反复点”按钮，体验未结束就反向的衔接。</p><button data-act="close">收起面板</button>');
  else close(phone);
};
document.getElementById('motion-tabs').onclick=()=>{
  const phone=document.querySelector('.phone.b'),pages=['devices','files','settings'];
  close(phone,true);route(phone,pages[(pages.indexOf(phone.dataset.page)+1)%3]);
};
document.addEventListener('keydown',e=>{const phone=[...document.querySelectorAll('.phone')].find(p=>!p.querySelector('.overlay').hidden);if(!phone)return;if(e.key==='Escape')close(phone);if(e.key==='Tab'){const items=[...phone.querySelector('.sheet').querySelectorAll('button')];if(e.shiftKey&&(document.activeElement===items[0]||document.activeElement===phone.querySelector('.sheet'))){e.preventDefault();items[items.length-1].focus();}else if(!e.shiftKey&&document.activeElement===items[items.length-1]){e.preventDefault();items[0].focus();}}});
