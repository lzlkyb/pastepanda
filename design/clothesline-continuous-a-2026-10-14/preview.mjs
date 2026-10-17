import { mountClothesline } from '../../src/clothesline/runtime.mjs';
import { beginDrag, moveDrag, endDrag, originalPinRect, resolveDropRect, regrabPreviewRect, snapToRope } from './policy.mjs';

document.documentElement.dataset.theme = 'ocean-dark';
const $ = id => document.getElementById(id);
const state = { items: [], enabled: true, wind: true, locked: false, anchors: null, workArea: { x: 0, y: 0, width: innerWidth, height: innerHeight }, scale: 1 };
const pins = new Map();
let callbacks, uid = 0, pointer = null, demo = null, busy = false;
const status = message => { $('proposalStatus').textContent = message; };
const publish = () => callbacks?.update(structuredClone(state));
const image = '/docs/manual/og-image.png';
const safe = promise => Promise.resolve(promise).catch(error => document.dispatchEvent(new CustomEvent('clothesline-error', { detail: String(error) })));
function add() {
  state.items.push({ id: 'shot-' + ++uid, path: 'preview-' + uid, name: '示例截图 ' + uid, source: 'HTML 设计稿', width: 1200, height: 630, url: image });
  publish();
}
function paint(pin) {
  const record = pins.get(pin.generation);
  if (!record?.el) return;
  const rect = pin.rect;
  for (const [name, value] of Object.entries({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })) record.el.style.setProperty('--pin-' + name, value + 'px');
}
function removePin(pin) {
  const record = pins.get(pin.generation);
  record?.stop?.();
  record?.el?.remove();
  pins.delete(pin.generation);
}
function makePin(item, rect) {
  const pin = { hwnd: 100 + uid, generation: ++uid, path: item.path, rect: { ...rect } };
  const factor = Math.min(240 / item.width, 180 / item.height, 1);
  pins.set(pin.generation, { item, pin, previewSize: { width: item.width * factor, height: item.height * factor } });
  return pin;
}
function contactY() {
  const card = document.querySelector('#hangs .hang');
  return card ? parseFloat(card.style.top) : 32;
}
function dropTarget(point) {
  const box = $('applicationTarget').getBoundingClientRect();
  return point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom ? 'application' : 'desktop';
}
function releasePreview(pin, point, target = dropTarget(point)) {
  const record = pins.get(pin.generation);
  const landed = resolveDropRect(pin.rect, record.item, point, { target, scale: state.scale });
  $('applicationTarget').classList.remove('receiving');
  if (!landed) {
    $('applicationResult').textContent = '已接收 ' + record.item.name + ' · 原图 ' + record.item.width + ' × ' + record.item.height + '（本地模拟）';
    removePin(pin);
    status('应用已接收原图（本地模拟），不展开桌面贴图。');
    // Replace the production controller's desktop-only success copy after its commit.
    setTimeout(() => { $('toast').textContent = '原图已交付（本地模拟），未生成桌面贴图'; }, 0);
  } else {
    pin.rect = landed; paint(pin);
    status('已在桌面松手 · 以松手位置为中心显示原图 100% 大小。');
  }
}
function showPin(pin) {
  const record = pins.get(pin.generation);
  if (!record || record.el) return;
  const el = document.createElement('div');
  el.className = 'proposalPin';
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', '贴图 ' + record.item.name);
  el.tabIndex = 0;
  const img = document.createElement('img');
  img.src = record.item.url;
  img.alt = record.item.name;
  img.draggable = false;
  const size = document.createElement('span');
  size.className = 'proposalPinSize';
  size.textContent = '100% · ' + record.item.width + ' × ' + record.item.height;
  const back = document.createElement('button');
  back.textContent = '挂回绳子';
  back.onclick = () => safe(callbacks.pinDrop({ ...pin, force: true }));
  el.append(img, size, back);
  record.el = el;
  $('stage').append(el);
  paint(pin);
  el.onpointerdown = event => {
    if (event.button !== 0 || event.target.closest('button')) return;
    event.preventDefault();
    follow(pin, { x: event.clientX, y: event.clientY }, event.pointerId);
  };
}
function follow(pin, point, pointerId, preview = false) {
  const record = pins.get(pin.generation), el = record.el;
  const before = { ...pin.rect };
  const drag = beginDrag(pin.rect, point, contactY());
  const rope = [...($('ropePath').getAttribute('d') || '').matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map(match => ({ x: Number(match[1]), y: Number(match[2]) }));
  let lastPoint = point, moved = preview, snap = null;
  el.classList.add('dragging');
  // The browser mock owns one complete gesture; actual Win32 acknowledgement remains a product task.
  const life = new AbortController();
  record.stop = () => life.abort();
  try { el.setPointerCapture(pointerId); } catch { /* Document listeners cover the handoff in this mock. */ }
  const finish = cancelled => {
    life.abort();
    el.classList.remove('dragging');
    if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
    endDrag(drag, cancelled);
    const target = dropTarget(lastPoint);
    $('applicationTarget').classList.remove('receiving');
    if (cancelled && !preview || !moved) {
      safe(callbacks.pinPreview(null));
      pin.rect = before; paint(pin);
      status(cancelled ? '已取消拖动，原图大小和位置恢复。' : '单击未移动，保留原图大小。');
    } else if (!cancelled && target === 'application') {
      safe(callbacks.pinPreview(null));
      releasePreview(pin, lastPoint, target);
    } else if (cancelled || snap) {
      const payload = cancelled ? { ...pin, force: true } : { ...pin, point: [snap.x, snap.y] };
      safe(callbacks.pinDrop(payload));
      status('正在挂回 · 接收成功后再移除贴图。');
    } else {
      safe(callbacks.pinPreview(null));
      releasePreview(pin, lastPoint, target);
    }
  };
  const updatePoint = event => {
    lastPoint = { x: event.clientX, y: event.clientY };
    if (preview) {
      moveDrag(drag, lastPoint); pin.rect = { ...drag.rect };
    } else {
      moved ||= Math.hypot(lastPoint.x - point.x, lastPoint.y - point.y) >= 4;
      pin.rect = regrabPreviewRect(before, point, lastPoint, record.previewSize);
    }
    if (!moved) return;
    paint(pin);
    const application = dropTarget(lastPoint) === 'application';
    snap = application ? null : snapToRope(lastPoint, rope, !!snap);
    $('applicationTarget').classList.toggle('receiving', application);
    safe(callbacks.pinPreview(snap ? { ...pin, point: [snap.x, snap.y] } : null));
    status(application ? '松手发送原图（本地模拟），不展开大贴图。' : snap ? '挂回位置已显示 · 松手夹回，移开继续拖动，Esc 恢复原位。' : '保持小图继续拖动 · 鼠标靠近绳子即可预览挂回位置。');
  };
  document.addEventListener('pointermove', event => {
    if (event.pointerId === pointerId) updatePoint(event);
  }, { signal: life.signal });
  document.addEventListener('pointerup', event => {
    if (event.pointerId !== pointerId) return;
    updatePoint(event); finish(false);
  }, { signal: life.signal });
  document.addEventListener('pointercancel', event => { if (event.pointerId === pointerId) finish(true); }, { signal: life.signal });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') finish(true); }, { signal: life.signal });
}
document.addEventListener('pointerdown', event => { pointer = { id: event.pointerId, held: true, point: { x: event.clientX, y: event.clientY } }; }, true);
document.addEventListener('pointermove', event => { if (pointer?.id === event.pointerId) pointer.point = { x: event.clientX, y: event.clientY }; }, true);
document.addEventListener('pointerup', event => { if (pointer) { pointer.held = false; pointer.point = { x: event.clientX, y: event.clientY }; } }, true);
document.addEventListener('pointercancel', () => { if (pointer) pointer.held = false; }, true);
// The mock application is another DOM surface. Relay events that leave the rope
// during the browser-side preparation, before the preview owns capture.
for (const type of ['pointermove', 'pointerup']) document.addEventListener(type, event => {
  if (!event.target.closest?.('#hangs') && document.querySelector('#hangs .hang.dragging')) $('hangs')['on' + type]?.(event);
});

const bridge = {
  safe, logical: r => r, physical: r => r,
  snapshot: async () => structuredClone(state), subscribe: async value => { callbacks = value; },
  prepare: async item => ({ ...item, url: image }), original: async () => image,
  ready: async () => { $('ropeLayer').hidden = true; },
  regions: () => {}, focusPreview: async () => {}, idle: () => {},
  config: async patch => {
    if ('clothesline_locked' in patch) state.locked = patch.clothesline_locked;
    if ('clothesline_anchors' in patch) state.anchors = patch.clothesline_anchors;
    publish();
  },
  remove: async ids => { state.items = state.items.filter(item => !ids.includes(item.id)); publish(); },
  restore: async items => { state.items = [...items.filter(item => !state.items.some(other => item.id === other.id)), ...state.items]; publish(); },
  order: async ids => { state.items = ids.map(id => state.items.find(item => item.id === id)).filter(Boolean); publish(); },
  take: async (item, rect) => { const pin = makePin(item, originalPinRect(rect, item, state.scale)); state.items = state.items.filter(other => other.id !== item.id); publish(); return pin; },
  dragTake: async (item, rect) => {
    const fail = $('failPrepare').checked;
    $('failPrepare').checked = false;
    status('夹子已松开 · 图片继续跟手，正在准备贴图。');
    await new Promise(resolve => setTimeout(resolve, $('slowPrepare').checked ? 1800 : 150));
    if (fail) {
      status('模拟准备失败 · 按住时保持跟手，松手后恢复，可重试。');
      if (pointer?.held) await new Promise(resolve => {
        const life = new AbortController();
        const done = () => { life.abort(); resolve(); };
        document.addEventListener('pointerup', done, { once: true, signal: life.signal });
        document.addEventListener('pointercancel', done, { once: true, signal: life.signal });
        document.addEventListener('keydown', event => { if (event.key === 'Escape') done(); }, { signal: life.signal });
      });
      throw new Error('模拟原图准备失败；松手后照片留在绳上，可重试');
    }
    // Only the drag preview is exposed while held; full-resolution pixels are retained in the item.
    const source = document.querySelector(`#hangs [data-id="${item.id}"]`), box = source?.getBoundingClientRect();
    const pin = makePin(item, box ? { x: box.x, y: box.y, width: box.width, height: box.height } : rect);
    state.items = state.items.filter(other => other.id !== item.id); publish();
    return pin;
  },
  startDrag: async (pin, rect, held, point) => {
    pin.rect = { ...rect }; showPin(pin);
    if (held && pointer?.held) {
      follow(pin, point || { x: rect.x, y: rect.y }, pointer.id, true);
      status('接力完成 · 保持缩略图大小，继续拖到桌面或应用。');
    } else releasePreview(pin, point || pointer?.point || { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    return pin;
  },
  showPin: async pin => showPin(pin), closePin: async pin => removePin(pin),
  returnPin: async (pin, id, slot) => {
    const item = pins.get(pin.generation).item;
    removePin(pin); state.items = state.items.filter(other => other.id !== item.id);
    state.items.splice(Math.min(slot ?? state.items.length, state.items.length), 0, item); publish();
    status('已挂回绳子 · 再次取下仍可拖成小图、放成原图。');
    return item;
  },
  photoForPin: async pin => pins.get(pin.generation).item,
  manager: () => { status('本稿的贴图可直接点「挂回绳子」。产品中的贴图管理面板保留。'); },
  dispose: () => { for (const record of pins.values()) record.stop?.(); },
};

await mountClothesline(bridge);
$('qaAdd').onclick = add;
$('qaReset').onclick = () => location.reload();
function demoFinish(cancelled, target = 'desktop') {
  if (!demo) return;
  endDrag(demo.drag, cancelled);
  demo.record.el.classList.remove('dragging');
  if (cancelled) { removePin(demo.pin); state.items.push(demo.record.item); publish(); }
  else releasePreview(demo.pin, demo.point, target);
  demo = null;
  for (const id of ['demoContinue', 'demoRelease', 'demoReturn', 'demoSend']) $(id).disabled = true;
  $('demoHold').disabled = false;
  if (cancelled) status('已主动拉回取消，照片恢复。');
}
$('demoHold').onclick = () => {
  if (demo || busy) return;
  const source = document.querySelector('#hangs .hang');
  const item = state.items.find(item => item.id === source?.dataset.id);
  if (!source || !item) { status('先采集一张图片，再演示按住停留。'); return; }
  const bounds = source.getBoundingClientRect(), contact = parseFloat(source.style.top);
  const rect = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const pin = makePin(item, rect); showPin(pin);
  const record = pins.get(pin.generation), drag = beginDrag(rect, point, contact);
  moveDrag(drag, { x: point.x, y: point.y + 44 }); pin.rect = drag.rect; paint(pin);
  record.el.classList.add('dragging');
  state.items = state.items.filter(other => other.id !== item.id); publish();
  demo = { pin, record, drag, point: { x: point.x, y: point.y + 44 } };
  $('demoHold').disabled = true;
  for (const id of ['demoContinue', 'demoRelease', 'demoReturn', 'demoSend']) $(id).disabled = false;
  status('演示中：左键保持按住，下拖后停住；图片会一直留在这里，直到继续或松手。');
};
$('demoContinue').onclick = () => {
  if (!demo) return;
  demo.point.y += 80; moveDrag(demo.drag, demo.point); paint(demo.pin);
  status('演示中：继续下拖，抓取位置保持一致；再次停住也不回弹。');
};
$('demoRelease').onclick = () => demoFinish(false);
$('demoSend').onclick = () => demoFinish(false, 'application');
$('demoReturn').onclick = () => demoFinish(true);
document.addEventListener('keydown', event => { if (event.key === 'Escape' && demo) demoFinish(true); });
$('replayFirst').onclick = async () => {
  if (busy || demo) return;
  busy = true; $('replayFirst').disabled = true;
  for (const record of pins.values()) removePin(record.pin);
  state.items = []; publish(); $('ropeLayer').hidden = true;
  $('applicationResult').textContent = '本地模拟，不向外部应用发送。';
  status('演示冷启动：首张截图即将完成，不需要点击绳子所在区域。');
  await new Promise(resolve => setTimeout(resolve, 350));
  add(); $('ropeLayer').hidden = false;
  status('首张截图已自动显示。可以直接按住相框向下拖动。');
  busy = false; $('replayFirst').disabled = false;
};
$('replayFirst').onclick();
