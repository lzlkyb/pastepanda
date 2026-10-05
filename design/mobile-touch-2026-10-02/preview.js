/* Local interaction proposal: no backend calls. */
const $ = (id) => document.getElementById(id);
const extraIcons = {
  ArrowLeft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 19-7-7 7-7M5 12h14"/></svg>',
  ChevronRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
};
document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = window.PANDA_ICONS[el.dataset.icon] || extraIcons[el.dataset.icon] || ''; });
let plan = 'B', direct = false, dragging = false, scrolling = false, zoom = 1, restoreFocus;
const plans = {
  A: ['A · 轻量反馈', '只补按钮按压、提示和弹层过渡。改动小，但双指误判与精准操作问题仍然存在。'],
  B: ['B · 稳定触控', '保留触控板默认模式，补齐从按下、手势识别到结束的反馈。最适合远程电脑的小按钮和复杂页面。'],
  C: ['C · 直接点击优先', '进入会话就直接点击画面，操作直观；小目标容易被手指挡住，需要更频繁缩放。触控板仍可切换。'],
};
function tell(text) { $('gestureMessage').textContent = text; }
function mode() {
  $('mode').textContent = dragging ? '拖拽中 · 点释放结束' : scrolling ? '滚动中 · 点滚动退出' : direct ? '直接点击 · 点按目标位置' : '触控板 · 划动移动指针';
  $('pointerLabel').textContent = direct ? '直接点击' : '触控板';
  $('drag').textContent = dragging ? '释放拖拽' : '拖拽';
  $('drag').setAttribute('aria-pressed', dragging);
  $('scroll').setAttribute('aria-pressed', scrolling);
}
function cancel() { dragging = scrolling = false; $('charge').hidden = true; mode(); }
document.querySelectorAll('[data-plan]').forEach((button) => button.onclick = () => {
  plan = button.dataset.plan; direct = plan === 'C'; cancel();
  document.querySelectorAll('[data-plan]').forEach(b => b.setAttribute('aria-pressed', b === button));
  $('planTitle').textContent = plans[plan][0]; $('planText').textContent = plans[plan][1];
  tell(plan === 'A' ? '轻量方案：保持原手势逻辑' : '在画面划动、长按，试试反馈。');
});
function ripple() {
  const el = document.createElement('div'); el.className = 'ripple';
  el.style.left = `${x - 13}px`; el.style.top = `${y - 13}px`; $('surface').append(el);
  setTimeout(() => el.remove(), 300);
}
function click(right = false) {
  tell(right ? '右键已触发（本地演示）' : '点击已触发（本地演示）'); ripple();
  $('target').classList.toggle('selected', !right);
}
let x = 190, y = 150;
function position(px, py) {
  const r = $('surface').getBoundingClientRect();
  x = Math.max(5, Math.min(r.width - 22, px)); y = Math.max(5, Math.min(r.height - 28, py));
  $('cursor').style.left = `${x}px`; $('cursor').style.top = `${y}px`;
}
position(190, 150);
$('left').onclick = () => click(); $('right').onclick = () => click(true);
$('drag').onclick = () => { dragging = !dragging; scrolling = false; mode(); tell(dragging ? '指针已按住 · 划动拖拽，点释放结束' : '拖拽已释放'); };
$('scroll').onclick = () => { scrolling = !scrolling; dragging = false; mode(); tell(scrolling ? '划动滚动页面 · 再点滚动退出' : '已退出滚动'); };
function open(title, body) {
  cancel(); restoreFocus = document.activeElement; $('sheetTitle').textContent = title; $('sheetBody').innerHTML = body;
  $('overlay').hidden = false; $('sheet').focus();
  $('sheetBody').querySelectorAll('button').forEach(b => b.onclick = () => {
    const act = b.dataset.act;
    if (act === 'trackpad' || act === 'direct') { direct = act === 'direct'; mode(); close(); tell('操作模式已切换'); }
    else if (act === 'reset') { zoom = 1; $('desktop').style.transform = 'scale(1)'; close(); tell('已适应屏幕'); }
    else { b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') !== 'true'); b.textContent = '已切换（本地演示）'; }
  });
}
function close() { $('sheet').style.transform = ''; $('sheet').style.transition = ''; $('overlay').hidden = true; restoreFocus?.focus(); }
$('close').onclick = close;
$('overlay').onclick = e => { if (e.target === $('overlay')) close(); };
$('pointer').onclick = () => open('操作方式', '<button data-act="trackpad">触控板 · 划动移动，点按点击</button><button data-act="direct">直接点击 · 点按目标</button><p>两种模式共用右键、拖拽与滚动按钮。</p>');
$('view').onclick = () => open('画面', '<button data-act="reset">适应屏幕</button><button data-act="quality">画质 · 均衡</button><p>捏合缩放画面，双指同向移动滚动电脑页面。</p>');
$('more').onclick = () => open('更多', '<button data-act="audio">电脑声音 · 已关闭</button><button data-act="clip">剪贴板</button><p>在把手向下拖动，试试跟手关闭；拖动不足会回位。</p>');
let sheetStart = null, sheetDelta = 0;
$('handle').onpointerdown = e => { sheetStart = e.clientY; sheetDelta = 0; $('handle').setPointerCapture(e.pointerId); $('sheet').style.transition = 'none'; };
$('handle').onpointermove = e => { if (sheetStart !== null) { sheetDelta = Math.max(0, e.clientY - sheetStart); $('sheet').style.transform = `translateY(${sheetDelta}px)`; } };
$('handle').onpointerup = () => { $('sheet').style.transition = ''; if (sheetDelta > 80 || sheetDelta < 4) close(); else $('sheet').style.transform = ''; sheetStart = null; };
$('handle').onpointercancel = () => { sheetStart = null; $('sheet').style.transition = ''; $('sheet').style.transform = ''; };
function keyboard(show) { cancel(); $('keyboard').hidden = !show; $('toolbar').hidden = show; if (show) $('draft').focus(); }
$('typing').onclick = () => keyboard(true); $('hideKeyboard').onclick = () => keyboard(false);
$('send').onclick = () => {
  if (!$('draft').value.trim()) { $('sendStatus').textContent = '先输入要发送的文字。'; return; }
  $('send').disabled = true; $('send').textContent = '发送中'; $('sendStatus').textContent = '正在发送（本地演示）';
  setTimeout(() => { $('send').disabled = false; $('send').textContent = '发送'; $('sendStatus').textContent = '发送成功（本地演示）'; $('draft').value = ''; }, 700);
};
document.querySelectorAll('[data-key]').forEach(b => b.onclick = () => { b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') !== 'true'); $('sendStatus').textContent = `${b.dataset.key} 已触发（本地演示）`; });
$('rotate').onclick = () => { cancel(); document.querySelector('.phone').classList.toggle('landscape'); tell('横屏高度示意 · 真机按屏幕方向调整'); };
$('back').onclick = () => { if (!$('keyboard').hidden) { keyboard(false); return; } cancel(); $('devices').hidden = false; $('control').hidden = $('toolbar').hidden = true; $('title').textContent = 'PastePanda'; $('subtitle').textContent = '设备列表 · 示例'; };
$('deviceRow').onclick = () => { $('devices').hidden = true; $('control').hidden = $('toolbar').hidden = false; $('title').textContent = '工作电脑'; $('subtitle').textContent = '控制中 · 示例会话'; };
function charge() { $('charge').hidden = plan === 'A'; $('charge').style.left = `${x - 12}px`; $('charge').style.top = `${y - 10}px`; if (plan !== 'A') tell('长按已识别 · 松手右键，移动拖拽'); }
document.querySelectorAll('[data-demo]').forEach(b => b.onclick = () => {
  cancel();
  if (b.dataset.demo === 'hold') charge();
  if (b.dataset.demo === 'scroll') tell('双指滚动已识别 · 本轮不切换成缩放');
  if (b.dataset.demo === 'pinch') { zoom = zoom === 1 ? 1.4 : 1; $('desktop').style.transform = `scale(${zoom})`; tell(`缩放 ${Math.round(zoom * 100)}% · 指尖跟随，不加动画延迟`); }
  if (b.dataset.demo === 'cancel') tell('手势已取消 · 拖拽与按键已释放（示例）');
});
const points = new Map(); let start, last, holdTimer, held = false, moved = false, pair, kind;
const geometry = () => { const [a,b] = [...points.values()]; return { x:(a.x+b.x)/2,y:(a.y+b.y)/2,d:Math.hypot(a.x-b.x,a.y-b.y) }; };
$('surface').onpointerdown = e => {
  if (e.button !== 0) return;
  $('surface').setPointerCapture(e.pointerId); points.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if (points.size === 1) { start = last = {x:e.clientX,y:e.clientY}; held = moved = false; const r = $('surface').getBoundingClientRect(); if (direct) position(e.clientX-r.left,e.clientY-r.top); holdTimer = setTimeout(() => { held = true; charge(); }, 550); }
  if (points.size === 2) { clearTimeout(holdTimer); $('charge').hidden = true; pair = { origin:geometry(),last:geometry() }; kind = null; held = false; }
};
$('surface').onpointermove = e => {
  if (!points.has(e.pointerId)) return;
  points.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if (points.size === 2 && pair) {
    const g = geometry(), delta = Math.hypot(g.x-pair.origin.x,g.y-pair.origin.y), spread = Math.abs(g.d-pair.origin.d);
    if (!kind && Math.max(delta,spread)>10) kind = spread>delta*1.4 ? 'pinch' : 'scroll';
    if (kind === 'pinch') { zoom = Math.min(4,Math.max(1,zoom*g.d/Math.max(1,pair.last.d))); $('desktop').style.transform = `scale(${zoom})`; tell(`缩放 ${Math.round(zoom*100)}%`); }
    if (kind === 'scroll') tell('双指滚动中 · 示例不改变真实电脑');
    pair.last = g; return;
  }
  if (points.size !== 1 || pair) return;
  const distance = Math.hypot(e.clientX-start.x,e.clientY-start.y);
  if (!moved && distance<10) return;
  moved = true; clearTimeout(holdTimer); const r = $('surface').getBoundingClientRect();
  if (held) { dragging = true; mode(); $('charge').hidden = true; }
  if (!scrolling) position(direct ? e.clientX-r.left : x+e.clientX-last.x,direct ? e.clientY-r.top : y+e.clientY-last.y);
  tell(scrolling ? '正在滚动页面（示例）' : dragging ? '拖拽中 · 松手释放' : '指针跟随 · 松手停止'); last = {x:e.clientX,y:e.clientY};
};
$('surface').onpointerup = e => {
  if (!points.delete(e.pointerId)) return; clearTimeout(holdTimer);
  if (!pair) { if (!moved) click(held); if (held && moved) { dragging = false; mode(); tell('拖拽已释放'); } }
  $('charge').hidden = true; if (!points.size) pair = null;
};
function abort() { clearTimeout(holdTimer); points.clear(); pair = null; cancel(); }
$('surface').onpointercancel = abort; window.addEventListener('blur',abort); document.addEventListener('visibilitychange',()=>{if(document.hidden)abort();});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (!$('overlay').hidden) close(); else if (!$('keyboard').hidden) keyboard(false); else cancel(); }
  if (e.key === 'Tab' && !$('overlay').hidden) { const buttons = [...$('sheet').querySelectorAll('button')]; if (e.shiftKey && (document.activeElement === buttons[0] || document.activeElement === $('sheet'))) { e.preventDefault(); buttons.at(-1).focus(); } else if (!e.shiftKey && document.activeElement === buttons.at(-1)) { e.preventDefault(); buttons[0].focus(); } }
});
