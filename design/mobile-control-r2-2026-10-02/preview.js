(() => {
const $=id=>document.getElementById(id);
const icons={...window.PANDA_ICONS,ArrowLeft:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"/><path d="M5 12h14"/></svg>'};
function paintIcons(root=document){root.querySelectorAll('[data-icon]').forEach(el=>{el.innerHTML=icons[el.dataset.icon]||icons.Monitor||'';});}
paintIcons();
const state={mode:'trackpad',mouse:false,pad:false,keyboard:false,landscape:false,collapsed:false,drag:false,scroll:false,status:'active',zoom:1.8,x:660,y:350,viewX:660,viewY:350,audio:false,quality:'balanced',scene:'control'};
let toastTimer,scale=1,ox=0,oy=0,focusBefore=null;
const desc={
control:['划动与点击，各做一件事','整块画面就是触控板。划动移动指针，点按在指针位置点击；小按钮不用靠指尖直接命中。'],
mouse:['把鼠标动作放到眼前','左键、右键、拖拽、滚动不用记手势。拖拽开启时持续显示按住态；切换输入模式会自动释放。'],
pad:['手指离开画面，目标保持清楚','独立触控板按需展开。指尖在下面移动，指针在上面定位；不会遮住电脑上的小按钮。'],
keyboard:['一行快捷键，保住操作空间','键盘打开后替换主工具栏。中文输入默认，常用组合键留在一行，扩展按键按需展开。这里使用系统键盘示意。'],
landscape:['工具收起后，还看得见入口','横屏工具栏收起后保留带文字的把手，不需要猜顶缘热区。点把手唤回工具，再点收起。'],
waiting:['让等待有阶段，也有出口','申请已通过，但还没有收到电脑画面。只显示当前阶段，不编造加载百分比；可以取消连接。'],
error:['异常时暂停输入，给恢复路径','画面异常时不再继续向冻结画面输入。给出重新连接、返回设备两条明确路径。']
};
function fit(){const rect=$('screen').getBoundingClientRect();scale=Math.min(rect.width/1280,rect.height/720)*state.zoom;ox=rect.width/2-state.viewX*scale;oy=rect.height/2-state.viewY*scale;ox=1280*scale<rect.width?(rect.width-1280*scale)/2:Math.max(rect.width-1280*scale,Math.min(0,ox));oy=720*scale<rect.height?(rect.height-720*scale)/2:Math.max(rect.height-720*scale,Math.min(0,oy));$('desktop').style.transform='translate('+ox+'px,'+oy+'px) scale('+scale+')';$('cursor').style.left=(ox+state.x*scale)+'px';$('cursor').style.top=(oy+state.y*scale)+'px';}
function notify(text){clearTimeout(toastTimer);$('feedback').textContent=text;$('feedback').hidden=false;toastTimer=setTimeout(()=>$('feedback').hidden=true,3000);}
function followPointer(){fit();const r=$('screen').getBoundingClientRect(),cx=ox+state.x*scale,cy=oy+state.y*scale;let dx=cx<24?cx-24:cx>r.width-24?cx-(r.width-24):0,dy=cy<24?cy-24:cy>r.height-24?cy-(r.height-24):0;state.viewX+=dx/scale;state.viewY+=dy/scale;if(dx||dy)fit();}
function render(){
$('device').classList.toggle('landscape',state.landscape);
$('mouseTools').hidden=!state.mouse||state.keyboard||state.status!=='active';
$('trackpad').hidden=!state.pad||state.keyboard||state.status!=='active';
$('keyboard').hidden=!state.keyboard||state.status!=='active';
$('toolbar').hidden=state.keyboard||state.collapsed||state.status!=='active';
$('toolHandle').hidden=!state.landscape||!state.collapsed||state.status!=='active'||state.keyboard;
$('collapseToolbar').hidden=!state.landscape;
$('toolHandle').querySelector('span').textContent=state.collapsed?'工具':'收起工具';
$('modeLabel').textContent=state.mode==='trackpad'?'触控板':'直接点击';
$('rotateLabel').textContent=state.landscape?'竖屏':'横屏';
$('modePill').textContent=state.drag?'拖拽中 · 再点拖拽释放':state.scroll?'滚动中 · 划动滚动页面':state.mode==='trackpad'?'触控板 · 划动移动指针':'直接点击 · 点击目标位置';
$('cursor').classList.toggle('dragging',state.drag);
document.querySelectorAll('[data-act="drag"]').forEach(b=>{b.setAttribute('aria-pressed',String(state.drag));b.textContent=state.drag?'释放拖拽':'拖拽';});
document.querySelectorAll('[data-act="scroll"]').forEach(b=>b.setAttribute('aria-pressed',String(state.scroll)));
$('stateCover').hidden=state.status==='active';
$('cursor').hidden=state.status!=='active';
$('modePill').hidden=state.status!=='active';
$('connectionLabel').textContent=state.status==='active'?'控制中':state.status==='waiting'?'等待画面':state.status==='ended'?'已结束':'连接异常';
if(state.status!=='active'){
$('stateTitle').textContent=state.status==='waiting'?'正在等待电脑画面':state.status==='ended'?'会话已结束':'与电脑的连接中断';
$('stateText').textContent=state.status==='waiting'?'电脑已接受连接，收到画面后即可操作。':state.status==='ended'?'电脑上的工作继续保留。':'当前输入已暂停，连接恢复后再继续操作。';
$('stateActions').innerHTML=state.status==='waiting'?'<button data-act="end">取消连接</button>':'<button data-act="reconnect">'+(state.status==='ended'?'重新开始演示':'重新连接')+'</button><button data-act="end">返回设备</button>';
}
fit();
}
new ResizeObserver(fit).observe($('screen'));
function release(){state.drag=false;state.scroll=false;document.querySelectorAll('[data-key][aria-pressed]').forEach(b=>b.setAttribute('aria-pressed','false'));}
function scene(name){release();closeSheet(false);state.scene=name;state.mode='trackpad';state.keyboard=name==='keyboard';state.mouse=name==='mouse'||name==='pad';state.pad=name==='pad';state.landscape=name==='landscape';state.collapsed=state.landscape;state.status=name==='error'?'error':name==='waiting'?'waiting':'active';state.zoom=1.8;state.x=660;state.y=350;state.viewX=660;state.viewY=350;$('feedback').hidden=true;clearTimeout(toastTimer);document.querySelectorAll('[data-scene]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.scene===name)));$('explainTitle').textContent=desc[name][0];$('explainText').textContent=desc[name][1];render();}
function sheet(title,body){focusBefore=document.activeElement;$('sheetTitle').textContent=title;$('sheetBody').innerHTML='<div class="sheet-body-actions">'+body+'</div>';$('overlay').hidden=false;paintIcons($('overlay'));$('overlay').querySelector('[role=dialog]').focus();}
function closeSheet(restore=true){$('overlay').hidden=true;if(restore&&focusBefore?.isConnected)focusBefore.focus();}
function clickAtPointer(button){if(state.status!=='active')return;const cursor=$('cursor').getBoundingClientRect(),target=$('target').getBoundingClientRect();if(button==='left'&&cursor.left>=target.left&&cursor.left<=target.right&&cursor.top>=target.top&&cursor.top<=target.bottom){$('target').classList.add('active');$('remoteNote').textContent='已选中：手机端交互规划（示意）';}notify(button==='right'?'右键操作 · 当前指针位置':'左键操作 · 当前指针位置');}
function action(name){
if(name==='close'){closeSheet();return;}
if(name==='mode'){sheet('鼠标模式','<p>触控板适合精确操作；直接点击适合目标较大的内容。</p><button data-act="trackpadMode" '+(state.mode==='trackpad'?'class="selected"':'')+'>触控板<span>划动移动 · 点按点击指针处</span></button><button data-act="directMode" '+(state.mode==='direct'?'class="selected"':'')+'>直接点击<span>点哪里，操作哪里</span></button><button data-act="mouse">鼠标辅助<span>左右键 / 拖拽 / 滚动</span></button><button data-act="pad">独立触控板<span>'+(state.pad?'收起':'展开')+'</span></button>');return;}
if(name==='trackpadMode'||name==='directMode'){release();state.mode=name==='directMode'?'direct':'trackpad';closeSheet();notify('已切换为'+(state.mode==='direct'?'直接点击':'触控板'));render();return;}
if(name==='mouse'){state.mouse=!state.mouse;closeSheet();render();return;}
if(name==='pad'){release();state.pad=!state.pad;state.mouse=state.pad||state.mouse;state.mode='trackpad';closeSheet();render();return;}
if(name==='keyboard'){release();state.keyboard=!state.keyboard;render();return;}
if(name==='rotate'){release();closeSheet(false);state.landscape=!state.landscape;state.collapsed=false;render();return;}
if(name==='reveal'){state.collapsed=!state.collapsed;render();return;}
if(name==='left'||name==='right'){clickAtPointer(name);return;}
if(name==='drag'){state.drag=!state.drag;state.scroll=false;render();notify(state.drag?'左键已按住 · 划动拖拽，再点释放':'已释放左键');return;}
if(name==='scroll'){state.scroll=!state.scroll;state.drag=false;render();notify(state.scroll?'划动滚动电脑页面，点滚动退出':'已退出滚动');return;}
if(name==='view'){sheet('画面','<button data-act="fit">适应屏幕</button><button data-act="zoom">放大画面</button><button data-act="pointer">回到指针</button><button data-act="rotate">切换到'+(state.landscape?'竖屏':'横屏')+'</button><h3>画质</h3><button data-quality="sharp">清晰</button><button data-quality="balanced">均衡</button><button data-quality="smooth">流畅</button><p>视野操作不更改电脑分辨率。画质选项在此演示选择反馈。</p>');return;}
if(name==='fit'||name==='zoom'||name==='pointer'){if(name==='fit')state.zoom=1;if(name==='zoom')state.zoom=Math.min(3,state.zoom+.5);if(name==='pointer'){state.viewX=state.x;state.viewY=state.y;}closeSheet();fit();notify(name==='fit'?'画面已适应屏幕':name==='zoom'?'画面已放大':'已回到指针位置');return;}
if(name==='more'){sheet('更多','<button data-act="view">画面与画质<i data-icon="Monitor"></i></button><button data-act="clipboard">剪贴板文字<i data-icon="Clipboard"></i></button><button data-act="sound">电脑声音<span>'+(state.audio?'已开启':'已关闭')+'</span></button><button data-act="help">手势使用指南</button><button data-act="end" class="danger">断开连接</button>');return;}
if(name==='clipboard'){sheet('剪贴板','<p>发送方向：手机 → 工作电脑</p><textarea aria-label="剪贴板示例文字">会议改到下午三点。（示例文字）</textarea><button class="primary" data-act="clipSend">发送到电脑</button><button data-act="clipPull">取回电脑文字</button><p>预览只演示方向和反馈，不读取真实系统剪贴板。</p>');return;}
if(name==='clipSend'||name==='clipPull'){closeSheet();notify(name==='clipSend'?'文字发送完成（演示）':'电脑文字已取回（演示）');return;}
if(name==='sound'){closeSheet();state.audio=!state.audio;notify(state.audio?'电脑声音已开启（演示）':'电脑声音已关闭（演示）');return;}
if(name==='help'){sheet('触控板手势','<p>划动：移动指针。点按：在指针处点击。右键、拖拽和滚动可通过鼠标辅助按钮完成。</p><button data-act="mouse" class="primary">展开鼠标辅助</button>');return;}
if(name==='keys'){sheet('扩展按键','<p>文字输入为默认模式。组合键高亮表示按住，执行后释放。</p><button data-key="Del">Delete · 删除</button><button data-key="Left">方向键 · 左</button><button data-key="Right">方向键 · 右</button><button data-key="Copy">复制 · Ctrl+C</button><button data-key="Paste">粘贴 · Ctrl+V</button><button data-key="All">全选 · Ctrl+A</button>');return;}
if(name==='send'){const t=$('draft').value;if(!t.trim()){notify('先输入要发送的文字');return;}$('remoteNote').textContent='已输入：'+t;notify('文字已发送（演示）');$('draft').value='';return;}
if(name==='end'){sheet(state.status==='waiting'?'取消连接？':'断开连接？','<p>电脑上的工作会继续保留。</p><button class="danger" data-act="confirmEnd">确认'+(state.status==='waiting'?'取消':'断开')+'</button><button data-act="close">继续连接</button>');return;}
if(name==='confirmEnd'){release();state.keyboard=false;state.status='ended';closeSheet(false);render();return;}
if(name==='reconnect'){scene('control');notify('已恢复演示画面');return;}
}
document.addEventListener('click',e=>{
const sceneButton=e.target.closest('[data-scene]');if(sceneButton){scene(sceneButton.dataset.scene);return;}
if(e.target.closest('#theme')){const dark=document.documentElement.dataset.theme==='midnight';document.documentElement.dataset.theme=dark?'ocean':'midnight';$('theme').textContent=dark?'深色外观':'浅色外观';return;}
const quality=e.target.closest('[data-quality]');if(quality){state.quality=quality.dataset.quality;document.querySelectorAll('[data-quality]').forEach(b=>b.setAttribute('aria-pressed',String(b===quality)));notify('画质已选择 '+quality.textContent+'（演示）');return;} const b=e.target.closest('[data-act]');if(b){action(b.dataset.act);return;}
const key=e.target.closest('[data-key]');if(key){if(key.hasAttribute('aria-pressed')){key.setAttribute('aria-pressed',String(key.getAttribute('aria-pressed')!=='true'));notify(key.dataset.key+(key.getAttribute('aria-pressed')==='true'?'已按住，再点释放':'已释放'));}else{notify(key.dataset.key+'已发送（演示）');document.querySelectorAll('[data-key][aria-pressed]').forEach(k=>k.setAttribute('aria-pressed','false'));if(!$('overlay').hidden)closeSheet();}return;}
const text=e.target.closest('[data-text]');if(text){$('draft').value=text.dataset.text==='⌫'?$('draft').value.slice(0,-1):$('draft').value+text.dataset.text;}
});
$('overlay').addEventListener('click',e=>{if(e.target===$('overlay'))closeSheet();});
function bindPointer(el,pad){let start=null;el.addEventListener('pointerdown',e=>{if(state.status!=='active'||!$('overlay').hidden)return;if(e.button!==0)return;start={id:e.pointerId,x:e.clientX,y:e.clientY,lastX:e.clientX,lastY:e.clientY,moved:false};el.setPointerCapture(e.pointerId);});
el.addEventListener('pointermove',e=>{if(!start||e.pointerId!==start.id)return;const dx=e.clientX-start.lastX,dy=e.clientY-start.lastY;start.lastX=e.clientX;start.lastY=e.clientY;if(Math.hypot(e.clientX-start.x,e.clientY-start.y)>4)start.moved=true;if(state.scroll){$('remoteNote').textContent='页面滚动（示意）';return;}if(state.mode==='trackpad'||pad){state.x+=dx/scale;state.y+=dy/scale;}else{const r=$('screen').getBoundingClientRect();state.x=(e.clientX-r.left-ox)/scale;state.y=(e.clientY-r.top-oy)/scale;}state.x=Math.max(0,Math.min(1280,state.x));state.y=Math.max(0,Math.min(720,state.y));followPointer();});
el.addEventListener('pointerup',e=>{if(!start||e.pointerId!==start.id)return;if(!start.moved&&!state.drag&&!state.scroll){if(state.mode==='direct'&&!pad){const r=$('screen').getBoundingClientRect();state.x=Math.max(0,Math.min(1280,(e.clientX-r.left-ox)/scale));state.y=Math.max(0,Math.min(720,(e.clientY-r.top-oy)/scale));fit();}clickAtPointer('left');}start=null;});el.addEventListener('pointercancel',()=>{start=null;release();render();});}
bindPointer($('screen'),false);bindPointer($('padSurface'),true);
document.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();if(!$('overlay').hidden)closeSheet();else if(state.keyboard){state.keyboard=false;render();}else if(state.pad||state.mouse){release();state.pad=false;state.mouse=false;render();}else action('end');}
if(e.key==='Tab'&&!$('overlay').hidden){const items=[...$('overlay').querySelectorAll('button,textarea')];const first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}});
window.addEventListener('blur',()=>{release();render();});
document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(toastTimer);release();render();}});
$('keyRows').innerHTML=['QWERTYUIOP','ASDFGHJKL','ZXCVBNM'].map(row=>'<div class="key-row">'+[...row].map(k=>'<button data-text="'+k.toLowerCase()+'">'+k.toLowerCase()+'</button>').join('')+'</div>').join('');
scene('control');
})();

