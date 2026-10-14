import { layout, equilibrium, springProgress, springImpulse, sample, restoreSnapshot, isDetached, clamp } from './physics.mjs';

const $ = id => document.getElementById(id);
const systemReduce = matchMedia('(prefers-reduced-motion: reduce)');
const state = { width: 1440, items: [], pins: [], uid: 0, enabled: true, wind: true, full: false };
const urls = new Set(), cards = new Map();
let geometry, target, curve, frame = 0, motion = null, windTimer = 0;
let drag = null, hovered = false, focused = false, previewId = null, returnFocus = null;
let undoAction = null, undoTimer = 0, toastTimer = 0, undoDeadline = 0, undoRemaining = 0, undoPaused = false, assetGeneration = 0;
const reduced = () => systemReduce.matches || $('reduce').checked;
const blocked = () => drag || hovered || focused || previewId !== null;
const available = () => state.enabled && !document.hidden && state.items.length > 0 && !reduced();
const titles = ['Q4 定价讨论', '页面布局参考', '交互验收清单', '版本数据', '产品讨论记录'];

function makeItem(url = null, aspect = 1.6, name = null) {
  const id = ++state.uid;
  return { id, aspect, url, name: name || titles[(id - 1) % titles.length], weight: 1 };
}

function photo(item) {
  const box = document.createElement('div'); box.className = 'photo';
  if (item.url) {
    const img = document.createElement('img'); img.src = item.url; img.alt = item.name; box.append(img);
  } else {
    const content = document.createElement('div'); content.className = 'sample';
    const bar = document.createElement('div'); bar.className = 'sampleBar'; bar.textContent = 'PastePanda · 演示图片';
    const title = document.createElement('strong'); title.textContent = item.name;
    const text = document.createElement('p'); text.textContent = item.id % 2 ? '把三个档位的价格再核一遍，特别是年付折后价。' : '点击查看原图，拖离绳带转为桌面贴图。';
    content.append(bar, title, text);
    if (!(item.id % 2)) {
      const bars = document.createElement('div'); bars.className = 'sampleLines';
      [40, 72, 52, 96].forEach(height => { const b = document.createElement('i'); b.style.setProperty('--bar', height + '%'); bars.append(b); });
      content.append(bars);
    }
    box.append(content);
  }
  return box;
}

function resize() {
  const zoom = state.full ? 1 : Math.min(1, $('viewport').clientWidth / state.width);
  $('stage').style.setProperty('--sw', state.width + 'px'); $('stage').style.setProperty('--zoom', zoom);
  $('stageWrap').style.width = state.width * zoom + 'px'; $('stageWrap').style.height = 760 * zoom + 'px';
}

function renderCards() {
  const ids = new Set(geometry.cards.map(c => c.item.id));
  for (const [id, el] of cards) if (!ids.has(id)) { el.remove(); cards.delete(id); }
  for (const card of geometry.cards) {
    let el = cards.get(card.item.id);
    if (!el) {
      el = document.createElement('div'); el.className = 'hang'; el.dataset.id = card.item.id;
      el.tabIndex = 0; el.setAttribute('role', 'group'); el.setAttribute('aria-label', '查看 ' + card.item.name + '，Enter 打开预览');
      const clip = document.createElement('span'); clip.className = 'clip';
      const paper = document.createElement('div'); paper.className = 'frame'; paper.append(photo(card.item));
      const caption = document.createElement('span'); caption.className = 'caption'; caption.textContent = '已保存 · ' + card.item.name;
      const take = document.createElement('button'); take.className = 'takeOne'; take.textContent = '取下为贴图';
      take.onclick = () => takeItem(card.item.id); paper.append(caption, take); el.append(clip, paper);
      $('hangs').append(el); cards.set(card.item.id, el);
      if (!reduced()) paper.animate([{ opacity: 0, transform: 'translateY(-24px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 300, easing: 'cubic-bezier(.05,.7,.1,1)' });
    }
    el.style.left = card.x + 'px'; el.style.setProperty('--iw', card.iw + 'px'); el.style.setProperty('--ih', card.ih + 'px');
    const clipCount = card.iw >= 150 ? 2 : 1;
    if (el.querySelectorAll('.clip').length !== clipCount) {
      el.querySelectorAll('.clip').forEach(clip => clip.remove());
      for (let i = 0; i < clipCount; i++) { const clip = document.createElement('span'); clip.className = 'clip'; el.prepend(clip); }
    }
  }
  $('emptyRope').hidden = state.items.length > 0;
  $('ropeLayer').hidden = !state.enabled;
  $('gather').disabled = !state.items.length; $('clear').disabled = !state.items.length;
  $('breeze').disabled = !available();
  $('stageStatus').textContent = state.enabled ? state.items.length + ' 张照片 · 收衣转贴图 / 大风清空' : '晾衣绳已关闭 · 此演示不改变原有采集';
  $('countValue').textContent = geometry.cards.length + ' / ' + geometry.queued;
  $('sagValue').textContent = Math.max(...target).toFixed(1) + 'px';
  const queue = $('queue'); queue.replaceChildren();
  for (const item of state.items.filter(item => !ids.has(item.id))) {
    const b = document.createElement('button'); b.textContent = '排队 · ' + item.name + ' → 转贴图'; b.onclick = () => takeItem(item.id); queue.append(b);
  }
}

function draw(values, windAngle = 0) {
  curve = values;
  $('ropePath').setAttribute('d', values.map((y, i) => `${i ? 'L' : 'M'}${(geometry.left + geometry.span * i / 64).toFixed(2)},${(16 + y).toFixed(2)}`).join(' '));
  $('ropeLayer').querySelector('.anchorR').style.left = geometry.right - 6 + 'px';
  for (const card of geometry.cards) {
    const el = cards.get(card.item.id); if (!el || drag?.id === card.item.id) continue;
    const t = (card.x - geometry.left) / geometry.span, y = sample(values, t);
    el.style.left = card.x + 'px'; el.style.top = 16 + y + 'px';
    const clips = [...el.querySelectorAll('.clip')];
    clips.forEach((clip, i) => {
      const fraction = clips.length === 1 ? .5 : i ? .74 : .26;
      const clipT = (card.x + (fraction - .5) * card.width - geometry.left) / geometry.span;
      const slope = (sample(values, clipT + .002) - sample(values, clipT - .002)) / (.004 * geometry.span);
      clip.style.left = fraction * 100 + '%'; clip.style.top = sample(values, clipT) - y - 5 + 'px';
      clip.style.setProperty('--tilt', Math.atan(slope) * 180 / Math.PI + 'deg');
    });
    el.style.setProperty('--angle', clamp((y - sample(target, t)) * -.5 + windAngle * Math.sin(Math.PI * t), -5, 5) + 'deg');
  }
}

function stop() { cancelAnimationFrame(frame); frame = 0; motion = null; $('motionValue').textContent = '休眠 · 无逐帧更新'; }
function scheduleWind() {
  clearTimeout(windTimer); windTimer = 0;
  if (available() && state.wind && !blocked()) windTimer = setTimeout(gust, 20000 + Math.random() * 25000);
  $('windStatus').textContent = !state.enabled ? '风已停止' : reduced() ? '减少动态 · 静态反馈' : blocked() ? '互动中 · 风暂停' : state.wind ? '偶发微风 · 20–45 秒' : '微风已关闭';
}

function animate(now) {
  if (!motion || !state.enabled || document.hidden) { stop(); return; }
  const seconds = (now - motion.start) / 1000;
  if (motion.kind === 'spring') {
    if (seconds >= 1.2) { draw(target); stop(); scheduleWind(); return; }
    const progress = springProgress(seconds), impulse = springImpulse(seconds, motion.kick);
    draw(target.map((y, i) => motion.from[i] + (y - motion.from[i]) * progress + impulse * Math.sin(Math.PI * i / 64)));
  } else {
    if (seconds >= 2.4 || blocked() || reduced()) { draw(target); stop(); scheduleWind(); return; }
    const envelope = Math.sin(Math.PI * seconds / 2.4) ** 2;
    draw(target.map((y, i) => y + 3 * envelope * Math.sin(Math.PI * i / 64) * Math.sin(seconds * 3 + i / 64) * motion.direction), 2 * envelope * Math.sin(seconds * 3) * motion.direction);
  }
  frame = requestAnimationFrame(animate);
}

function settle(kick = 0) {
  stop(); clearTimeout(windTimer);
  if (!state.enabled || document.hidden || reduced() || blocked()) { draw(target); scheduleWind(); return; }
  motion = { kind: 'spring', from: [...curve], start: performance.now(), kick };
  $('motionValue').textContent = '弹簧响应 · k130 / c16'; frame = requestAnimationFrame(animate);
}
function update(kick = 0, instant = false) {
  geometry = layout(state.width, state.items); target = equilibrium(geometry);
  curve ||= [...target]; renderCards();
  if (instant || reduced() || !state.enabled) { stop(); draw(target); scheduleWind(); } else settle(kick);
}
function gust() {
  clearTimeout(windTimer);
  if (!available() || blocked()) { scheduleWind(); return; }
  stop(); draw(target); motion = { kind: 'wind', start: performance.now(), direction: Math.random() < .5 ? -1 : 1 };
  $('motionValue').textContent = '短阵风 · 2.4 秒'; $('windStatus').textContent = '一阵轻风经过'; frame = requestAnimationFrame(animate);
}
function interactionChanged() {
  if (blocked()) { clearTimeout(windTimer); stop(); } else settle();
  scheduleWind();
}
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000); }

function tickUndo() {
  clearTimeout(undoTimer);
  if (undoPaused) return;
  const seconds = Math.max(0, (undoDeadline - performance.now()) / 1000); $('undoTime').textContent = Math.ceil(seconds) + 's';
  if (!seconds) { undoAction = null; $('undoBar').hidden = true; return; }
  undoTimer = setTimeout(tickUndo, 200);
}
function setUndo(message, run, kind = 'add') {
  clearTimeout(undoTimer); undoAction = { run, kind }; undoPaused = false; undoDeadline = performance.now() + 8000;
  $('undoText').textContent = message; $('undoBar').hidden = false; tickUndo();
}
$('undo').onclick = () => {
  const action = undoAction; undoAction = null; clearTimeout(undoTimer); $('undoBar').hidden = true;
  if (action) action.run();
};
function pauseUndo() { if (undoAction && !undoPaused) { undoPaused = true; undoRemaining = Math.max(0, undoDeadline - performance.now()); clearTimeout(undoTimer); } }
function resumeUndo() { if (undoAction && undoPaused && !$('undoBar').matches(':hover') && !$('undoBar').contains(document.activeElement)) { undoPaused = false; undoDeadline = performance.now() + undoRemaining; tickUndo(); } }
$('undoBar').onpointerenter = pauseUndo; $('undoBar').onpointerleave = resumeUndo;
$('undoBar').onfocusin = pauseUndo; $('undoBar').onfocusout = event => { if (!$('undoBar').contains(event.relatedTarget)) resumeUndo(); };

function add(item) {
  if (!state.enabled) { toast('晾衣绳已关闭，本张不上绳；产品原有采集照旧'); return; }
  state.items.push(item); update(130);
  if (undoAction?.kind !== 'clear') setUndo('已挂上「' + item.name + '」', () => { state.items = state.items.filter(x => x.id !== item.id); update(-90); toast('本张已从绳上移除，历史保留'); });
  toast('新照片已挂上' + (geometry.queued ? ' · 另有 ' + geometry.queued + ' 张排队' : ''));
}

function fly(el, index = 0) {
  if (!el || reduced()) return;
  const clone = el.cloneNode(true); clone.removeAttribute('tabindex'); clone.removeAttribute('role'); clone.classList.remove('dragging');
  $('fxLayer').append(clone);
  const animation = clone.animate([
    { transform: 'translateX(-50%) rotate(0deg)', opacity: 1 },
    { transform: 'translateX(-50%) translate(70px,-12px) rotate(-9deg)', opacity: 1, offset: .25 },
    { transform: `translateX(-50%) translate(${state.width}px,-160px) rotate(35deg)`, opacity: 0 }
  ], { duration: 400, delay: index * 35, easing: 'cubic-bezier(.2,0,0,1)', fill: 'forwards' });
  animation.finished.then(() => clone.remove(), () => clone.remove());
}
function clearRope() {
  if (!state.items.length) return;
  cancelDrag(); closePreview(false);
  const snapshot = [...state.items]; [...cards.values()].forEach(fly);
  state.items = []; update(-130);
  setUndo('已吹走 ' + snapshot.length + ' 张 · 历史保留', () => {
    state.items = restoreSnapshot(state.items, snapshot, 8).items;
    update(100); toast('已恢复 ' + snapshot.length + ' 张；之后新增的照片仍保留' + (geometry.queued ? ' · 旧照片已排队' : ''));
  }, 'clear');
  toast('大风清空了绳子，剪贴板历史仍保留');
}

function renderPins() {
  $('pins').replaceChildren(); $('pinList').replaceChildren(); $('pinCount').textContent = state.pins.length + ' 张';
  if (!state.pins.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '收衣后生成的桌面贴图会列在这里'; $('pinList').append(empty); }
  state.pins.forEach(pin => {
    const el = document.createElement('div'); el.className = 'pinGhost'; el.dataset.pin = pin.item.id;
    Object.assign(el.style, { left: pin.x + 'px', top: pin.y + 'px', width: pin.width + 'px', height: pin.height + 'px' }); el.append(photo(pin.item));
    const close = document.createElement('button'); close.className = 'pinClose'; close.textContent = '×'; close.setAttribute('aria-label', '关闭贴图 ' + pin.item.name);
    close.onclick = () => { state.pins = state.pins.filter(p => p !== pin); renderPins(); toast('贴图已关闭，历史保留'); }; el.append(close); $('pins').append(el);
    const row = document.createElement('div'); row.className = 'row';
    const name = document.createElement('span'); name.className = 'name'; name.textContent = pin.item.name;
    const back = document.createElement('button'); back.textContent = '挂回'; back.onclick = () => {
      state.pins = state.pins.filter(p => p !== pin); if (!state.items.some(item => item.id === pin.item.id)) state.items.push(pin.item);
      renderPins(); update(100); toast('已挂回，桌面贴图同时移除');
    }; row.append(name, back); $('pinList').append(row);
  });
}
function createPin(item, x, y) {
  if ($('failPin').checked) { $('failPin').checked = false; return false; }
  const width = 200, height = Math.min(180, Math.round(width / item.aspect));
  const index = state.pins.length;
  const pin = { item, width, height, x: clamp(x ?? 80 + index % 3 * 224, 16, state.width - width - 16), y: clamp(y ?? 320 + Math.floor(index / 3) % 3 * 140, 32, 720 - height) };
  state.pins.push(pin);
  const source = cards.get(item.id);
  if (source && !reduced()) {
    const clone = source.cloneNode(true); clone.removeAttribute('tabindex'); clone.removeAttribute('role'); clone.classList.remove('dragging'); $('fxLayer').append(clone);
    const dx = pin.x + width / 2 - parseFloat(source.style.left), dy = pin.y - parseFloat(source.style.top);
    const transfer = clone.animate([
      { transform: 'translateX(-50%)', opacity: 1 },
      { transform: `translateX(-50%) translate(${dx}px,${dy}px) scale(${width / source.offsetWidth})`, opacity: 0 }
    ], { duration: 300, easing: 'cubic-bezier(.2,0,0,1)' });
    transfer.finished.then(() => clone.remove(), () => clone.remove());
  }
  state.items = state.items.filter(i => i.id !== item.id); return true;
}
function takeItem(id, x, y) {
  const item = state.items.find(i => i.id === id); if (!item) return;
  if (!createPin(item, x, y)) { toast('贴图创建失败，照片仍在绳上 · 点击取下为贴图可重试'); return; }
  renderPins(); update(-90); toast('已转为桌面贴图 · 可在管理面板挂回');
}
function gather() {
  cancelDrag(); closePreview(false);
  const snapshot = [...state.items]; let succeeded = 0;
  snapshot.forEach(item => { if (createPin(item)) succeeded++; });
  renderPins(); update(-130);
  toast(succeeded === snapshot.length ? `已收下 ${succeeded} 张，转为桌面贴图` : `已转贴图 ${succeeded}/${snapshot.length} 张；失败照片留在绳上，可重试`);
}

function openPreview(id) {
  const item = state.items.find(x => x.id === id); if (!item) return;
  returnFocus = document.activeElement; previewId = id; $('loupeImage').replaceChildren(photo(item));
  $('loupeCaption').textContent = item.name; $('loupe').hidden = false; interactionChanged(); $('closePreview').focus();
}
function closePreview(focus = true) {
  if (previewId === null) return;
  previewId = null; $('loupe').hidden = true;
  if (focus && returnFocus?.isConnected) returnFocus.focus(); focused = false; interactionChanged();
}
$('pinPreview').onclick = () => { const id = previewId; closePreview(false); takeItem(id); };
$('closePreview').onclick = () => closePreview();

function cancelDrag() {
  if (!drag) return;
  const active = drag; drag = null; active.el.classList.remove('dragging'); $('dragHint').hidden = true;
  if (active.el.hasPointerCapture(active.pointerId)) active.el.releasePointerCapture(active.pointerId);
  draw(target); interactionChanged();
}
$('hangs').onpointerdown = event => {
  const el = event.target.closest('.hang'); if (!el || event.target.closest('button') || event.button !== 0) return;
  drag = { el, id: +el.dataset.id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: parseFloat(el.style.left), top: parseFloat(el.style.top), dx: 0, dy: 0, moved: false };
  el.setPointerCapture(event.pointerId); interactionChanged();
};
$('hangs').onpointermove = event => {
  if (!drag) return;
  const zoom = parseFloat($('stage').style.getPropertyValue('--zoom'));
  drag.dx = (event.clientX - drag.x) / zoom; drag.dy = (event.clientY - drag.y) / zoom;
  if (!drag.moved && Math.hypot(drag.dx, drag.dy) < 4) return;
  drag.moved = true; drag.el.classList.add('dragging');
  drag.el.style.left = drag.left + drag.dx + 'px'; drag.el.style.top = drag.top + drag.dy + 'px';
  $('dragHint').hidden = !isDetached(drag.dx, drag.dy, drag.el.offsetHeight);
};
$('hangs').onpointerup = () => {
  if (!drag) return;
  const active = drag, detached = isDetached(active.dx, active.dy, active.el.offsetHeight); cancelDrag();
  if (!active.moved) openPreview(active.id); else if (detached) takeItem(active.id, active.left + active.dx - 100, active.top + active.dy);
};
$('hangs').onpointercancel = cancelDrag;
$('hangs').onlostpointercapture = () => { if (drag) cancelDrag(); };
$('hangs').onkeydown = event => { if (event.target.closest('button')) return; const el = event.target.closest('.hang'); if (el && ['Enter', ' '].includes(event.key)) { event.preventDefault(); openPreview(+el.dataset.id); } };
document.onkeydown = event => { if (event.key === 'Escape') { if (drag) cancelDrag(); else closePreview(); } };
$('stage').onpointermove = event => {
  const next = !!event.target.closest('.hang,.loupe,.undoBar,.pinPanel');
  if (next !== hovered) { hovered = next; interactionChanged(); }
};
$('stage').onpointerleave = () => { hovered = false; interactionChanged(); };
$('stage').onfocusin = () => { focused = true; interactionChanged(); };
$('stage').onfocusout = event => { if (!$('stage').contains(event.relatedTarget)) { focused = false; interactionChanged(); } };

$('addShot').onclick = $('emptyAdd').onclick = () => add(makeItem());
$('clear').onclick = clearRope; $('gather').onclick = gather; $('breeze').onclick = gust;
$('enabled').onchange = () => { cancelDrag(); closePreview(false); state.enabled = $('enabled').checked; update(0, true); toast(state.enabled ? '晾衣绳已开启，原来的照片仍保留' : '晾衣绳已关闭，照片保留；风动与逐帧更新停止'); };
$('wind').onchange = () => { state.wind = $('wind').checked; if (!state.wind && motion?.kind === 'wind') { stop(); draw(target); } scheduleWind(); };
$('reduce').onchange = () => update(0, true); systemReduce.onchange = () => update(0, true);
$('width').onchange = () => { cancelDrag(); state.width = +$('width').value; resize(); update(0, true); };
$('theme').onchange = () => { document.documentElement.dataset.theme = $('theme').value; };
$('scale').onclick = () => { state.full = !state.full; $('scale').setAttribute('aria-pressed', state.full); $('scale').textContent = state.full ? '适应窗口' : '100% 查看'; resize(); };
$('files').onchange = async () => {
  const files = [...$('files').files], generation = assetGeneration; $('files').value = '';
  for (const file of files) {
    const url = URL.createObjectURL(file); const img = new Image(); img.src = url;
    try { await img.decode(); if (generation !== assetGeneration) { URL.revokeObjectURL(url); return; } urls.add(url); add(makeItem(url, img.naturalWidth / img.naturalHeight, file.name)); }
    catch { URL.revokeObjectURL(url); toast('图片读取失败：' + file.name + ' · 请换一张图片重试'); }
  }
};
function reset() {
  assetGeneration++;
  cancelDrag(); closePreview(false); stop(); clearTimeout(windTimer); clearTimeout(undoTimer); undoAction = null; $('undoBar').hidden = true;
  for (const url of urls) URL.revokeObjectURL(url); urls.clear();
  state.items = Array.from({ length: 5 }, () => makeItem()); state.pins = []; $('fxLayer').replaceChildren();
  renderPins(); update(0, true);
}
$('reset').onclick = reset;
document.onvisibilitychange = () => { if (document.hidden) { stop(); clearTimeout(windTimer); } else update(0, true); };
window.addEventListener('blur', () => { cancelDrag(); stop(); clearTimeout(windTimer); });
window.addEventListener('focus', () => update(0, true));
window.addEventListener('resize', resize);
window.addEventListener('pagehide', () => { stop(); clearTimeout(windTimer); clearTimeout(undoTimer); clearTimeout(toastTimer); for (const url of urls) URL.revokeObjectURL(url); });
// 只读验收读数；UI 操作仍走实际按钮与指针事件。
window.clotheslineReadout = () => ({ count: state.items.length, pins: state.pins.length, queued: geometry.queued, sag: Math.max(...target), activeFrame: !!frame, windScheduled: !!windTimer, ids: state.items.map(i => i.id), reduced: reduced() });
resize(); reset();
