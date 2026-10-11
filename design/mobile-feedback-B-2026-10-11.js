/* Standalone proposal. All outcomes are simulated; no IPC, network, or real deletion. */
const $ = selector => document.querySelector(selector);
const icons = {
  check: '<path d="m9 12 2 2 4-4"/><circle cx="12" cy="12" r="9"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4m0 4h.01"/>',
  warning: '<path d="m10.3 3.4-8.1 14A2 2 0 0 0 3.9 20h16.2a2 2 0 0 0 1.7-2.6l-8.1-14a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 4h.01"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>',
  settings: '<path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 2 3-1 2 2 3-1 1-3 3-1 2-3-2-2 1-3-3-2-3 1-2-2Z"/><circle cx="12" cy="12" r="3"/>',
  key: '<circle cx="8" cy="8" r="5"/><path d="m12 12 9 9m-4-4 3-3m-6 0 3-3"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5 8a8 8 0 0 1 13-3l2 2M4 17l2 2a8 8 0 0 0 13-3"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="m12 5-7 7 7 7M5 12h14"/>',
  link: '<path d="m10 13 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 1 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"/>',
};
const icon = (name, extra = '') => `<svg ${extra} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.alert}</svg>`;
const scenes = {
  copy: { icon: 'check', title: '轻量成功', short: '看见结果，继续操作', level: '轻反馈', page: 'knowledge', description: '复制成功只需一行结果。轻浮层悬在导航上方，正文不位移，也不抢焦点。', where: '底部轻浮层', lifetime: '4 秒可见阅读时间；触摸、聚焦和后台暂停', block: '不阻断任何操作', action: '点击笔记中的“复制内容”' },
  field: { icon: 'key', title: '字段校验', short: '输入途中不责备用户', level: '局部问题', page: 'devices', description: '输入时给中性约束；提交后才显示具体错误。修改、取消和导航始终可用。', where: '出错的输入框下方', lifetime: '修正或重新提交后更新', block: '仅阻断本次连接提交', action: '输入任意短码并连接；再试示例接入码' },
  background: { icon: 'refresh', title: '后台恢复', short: '不把重试变成通知', level: '状态反馈', page: 'devices', description: '短暂检查失败在设备行表达。重复重试不刷屏；持续失败才升级为可恢复提示。', where: '设备状态 → 持久状态条', lifetime: '持续到用户重试并恢复', block: '不阻断其他功能', action: '模拟持续失败，再重新检查' },
  connection: { icon: 'monitor', title: '连接中断', short: '暂停输入，保留退出', level: '安全停止 · 当前任务', page: 'devices', description: '无法确认画面时暂停输入。说明影响并提供恢复与返回，不用确认框困住整个应用。', where: '会话内持久提示', lifetime: '恢复正常画面后原位更新', block: '仅暂停远控输入', action: '点击“重新连接”，观察状态交接' },
  batch: { icon: 'file', title: '部分失败', short: '一个摘要，逐项处理', level: '局部问题', page: 'files', description: '成功项保留成功，失败项留在任务行。一个批量摘要表达实际结果，避免多个错误叠加。', where: '批量摘要 + 失败任务行', lifetime: '失败项恢复前持续显示', block: '不影响成功项和其他任务', action: '重试单项，或重试全部失败项' },
  draft: { icon: 'book', title: '草稿未保存', short: '先保住内容，再谈离开', level: '局部问题 → 必须决定', page: 'knowledge', description: '保存失败留在编辑器，输入不丢。只有用户要离开且可能失去内容时，才进入保护性决策。', where: '编辑器错误区 / 离开确认', lifetime: '保存成功前保留', block: '保护未保存内容，仍可修改与复制', action: '模拟保存失败，再返回或重试' },
  danger: { icon: 'trash', title: '不可逆确认', short: '明确后果，安全优先', level: '必须决定', page: 'settings', description: '清空不可恢复记录前确认。默认聚焦取消，危险按钮写明动作，操作结果留在原任务范围。', where: '统一底部确认面板', lifetime: '等待用户明确选择', block: '只暂停当前清空流程', action: '点击“清空历史记录”' },
  priority: { icon: 'alert', title: '优先级与去重', short: '重要问题不被成功覆盖', level: '持续受限', page: 'files', description: '同一目录故障只留一条持久提示。后续普通成功就地反馈，不覆盖问题，也不补播陈旧消息。', where: '接收目录旁的持久提示', lifetime: '恢复权限前保持', block: '仅限制接收文件', action: '重复触发故障，再触发普通成功' },
};
let current = 'copy', timers = new Set(), motionFrames = new Set(), noticeClock = null, closingNotice = null;
let modalFocus = null, failedFiles = new Set([3, 4]), draftDirty = true, draftText = '刚想到的一个想法：\n\n把反馈放回任务本身。让用户一眼看见结果，也能继续手里的工作。';
const reduced = () => $('#reduce').checked || matchMedia('(prefers-reduced-motion: reduce)').matches;
const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };
const log = text => { $('#event').textContent = text; };
function spring(element) {
  if (reduced() || document.hidden) { element.style.transform = 'none'; return; }
  const start = performance.now(), w = Math.sqrt(130 - 64);
  const draw = now => {
    const t = (now - start) / 1000;
    const position = 12 * Math.exp(-8 * t) * (Math.cos(w * t) + 8 / w * Math.sin(w * t));
    element.style.transform = `translateY(${position}px)`;
    if (document.hidden || now - start > 1000 || reduced()) { element.style.transform = 'none'; return; }
    const frame = requestAnimationFrame(next => { motionFrames.delete(frame); draw(next); }); motionFrames.add(frame);
  };
  draw(start);
}
function stopNoticeClock() {
  if (!noticeClock?.timer) return;
  clearTimeout(noticeClock.timer); noticeClock.remaining -= Date.now() - noticeClock.started; noticeClock.timer = null;
}
function updateNoticeClock() {
  stopNoticeClock();
  if (!noticeClock || document.hidden || $('#phone').classList.contains('modal-open')) return;
  const el = $('#snackbar-slot').firstElementChild;
  if (!el || noticeClock.hovered || noticeClock.touching || el.contains(document.activeElement)) return;
  noticeClock.started = Date.now(); noticeClock.timer = setTimeout(() => dismissToast(), Math.max(0, noticeClock.remaining));
}
function dismissToast() {
  stopNoticeClock(); noticeClock = null;
  const toast = $('#snackbar-slot').firstElementChild;
  if (!toast) return;
  motionFrames.forEach(cancelAnimationFrame); motionFrames.clear();
  toast.style.transform = ''; toast.dataset.state = 'closing';
  closingNotice = later(() => { toast.remove(); closingNotice = null; }, reduced() ? 0 : 200);
}
function toast(title) {
  stopNoticeClock(); if (closingNotice) { clearTimeout(closingNotice); timers.delete(closingNotice); closingNotice = null; }
  $('#snackbar-slot').innerHTML = `<div class="snackbar" data-state="open"><span class="status-icon">${icon('check')}</span><strong>${title}</strong><button class="icon-close" aria-label="关闭提示" type="button">${icon('close')}</button></div>`;
  const el = $('#snackbar-slot').firstElementChild;
  el.querySelector('button').onclick = dismissToast;
  el.onpointerenter = event => { if (event.pointerType === 'mouse' && noticeClock) { noticeClock.hovered = true; stopNoticeClock(); } };
  el.onpointerleave = () => { if (noticeClock) noticeClock.hovered = false; updateNoticeClock(); };
  el.onpointerdown = () => { if (noticeClock) noticeClock.touching = true; stopNoticeClock(); };
  el.onpointerup = el.onpointercancel = () => { if (noticeClock) noticeClock.touching = false; updateNoticeClock(); };
  el.onfocusin = stopNoticeClock; el.onfocusout = () => later(updateNoticeClock, 0);
  noticeClock = { remaining: 4000, started: 0, timer: null }; spring(el); updateNoticeClock(); log(title);
}
function notice(tone, title, detail, button = '', id = '') {
  const name = { error: 'alert', warning: 'warning', pending: 'clock', success: 'check', info: 'alert' }[tone];
  return `<section ${id ? `id="${id}"` : ''} class="notice" data-tone="${tone}" role="status"><div class="notice-heading"><span class="status-icon">${icon(name)}</span><div><strong>${title}</strong><p>${detail}</p></div></div>${button}</section>`;
}
const action = (id, label, name = '') => `<button type="button" id="${id}" class="text-button">${name ? icon(name) : ''}${label}</button>`;
const header = (title, subtitle, button = '') => `<header class="page-header"><div><h2>${title}</h2><p>${subtitle}</p></div>${button}</header>`;
function deviceList(checking = false) {
  return `<h3 class="group-label">已配对设备</h3><div class="group"><div class="device-row"><span class="device-icon">${icon('monitor')}</span><div class="device-copy"><strong>工作电脑</strong><small>${checking ? '' : '<i class="dot"></i>'}${checking ? '在线状态检查中' : '在线 · Windows'}</small></div><button class="primary small-button" id="connect-device" type="button">连接</button></div><div class="device-row"><span class="device-icon">${icon('monitor')}</span><div class="device-copy"><strong>家里的电脑</strong><small>离线 · Windows</small></div><span class="hint">离线</span></div></div><p class="hint">点“连接”控制电脑；点设备查看观看、文件和管理操作。</p>`;
}
function clearScene() {
  timers.forEach(clearTimeout); timers.clear(); motionFrames.forEach(cancelAnimationFrame); motionFrames.clear();
  stopNoticeClock(); noticeClock = null; closingNotice = null; $('#snackbar-slot').replaceChildren(); closeModal(true);
}
function setScene(id, auto = true) {
  clearScene(); current = id; const scene = scenes[id];
  history.replaceState(null, '', `#${id}`);
  document.querySelectorAll('.scene-button').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.scene === id)));
  $('#level').textContent = scene.level; $('#scene-title').textContent = scene.title; $('#scene-description').textContent = scene.description;
  $('#rules').innerHTML = [['呈现位置', scene.where], ['停留规则', scene.lifetime], ['阻断范围', scene.block], ['怎么体验', scene.action]].map(([name, value]) => `<dt>${name}</dt><dd>${value}</dd>`).join('');
  $('#navigation').innerHTML = [['devices', 'monitor', '设备'], ['files', 'file', '文件'], ['knowledge', 'book', '知识库'], ['settings', 'settings', '设置']].map(([page, name, label]) => `<button data-page="${page}" type="button" ${scene.page === page ? 'aria-current="page"' : ''}>${icon(name)}${label}</button>`).join('');
  $('#navigation').querySelectorAll('button').forEach(button => button.onclick = () => {
    const next = { devices: 'background', files: 'batch', knowledge: 'copy', settings: 'danger' }[button.dataset.page];
    if (current === 'draft' && draftDirty) leaveDraft(() => setScene(next)); else setScene(next);
  });
  log('等待操作'); renderers[id](auto);
}
function closeModal(immediate = false) {
  const sheet = $('#modal-slot').firstElementChild;
  if (!sheet) return;
  const done = () => { $('#modal-slot').replaceChildren(); $('#phone').classList.remove('modal-open'); $('#app').inert = false; $('#navigation').inert = false; $('#snackbar-slot').inert = false; if (modalFocus?.isConnected && !immediate) modalFocus.focus(); updateNoticeClock(); };
  if (immediate) done(); else { motionFrames.forEach(cancelAnimationFrame); motionFrames.clear(); sheet.style.transform = ''; sheet.dataset.state = 'closing'; later(done, reduced() ? 0 : 250); }
}
function modal(title, detail, buttons, warning = false) {
  modalFocus = document.activeElement; $('#phone').classList.add('modal-open'); $('#app').inert = true; $('#navigation').inert = true; $('#snackbar-slot').inert = true; stopNoticeClock();
  $('#modal-slot').innerHTML = `<section class="confirm-sheet" data-state="open" role="dialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-detail"><span class="sheet-handle" aria-hidden="true"></span><div class="confirm-icon ${warning ? 'warning' : ''}">${icon(warning ? 'warning' : 'trash')}</div><h3 id="confirm-title">${title}</h3><p id="confirm-detail">${detail}</p><div class="confirm-actions">${buttons.map((b, i) => `<button type="button" data-index="${i}" class="${b.type}">${b.label}</button>`).join('')}</div></section>`;
  const sheet = $('#modal-slot').firstElementChild; spring(sheet);
  sheet.querySelectorAll('button').forEach(button => button.onclick = () => buttons[Number(button.dataset.index)].run());
  sheet.querySelector('button').focus();
  sheet.onkeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); closeModal(); log('已取消，原内容保留'); }
    if (event.key === 'Tab') { const items = [...sheet.querySelectorAll('button')], index = items.indexOf(document.activeElement); if (event.shiftKey && index === 0) { event.preventDefault(); items.at(-1).focus(); } else if (!event.shiftKey && index === items.length - 1) { event.preventDefault(); items[0].focus(); } }
  };
}
function leaveDraft(onLeave) {
  modal('内容还没有保存', '输入仍在本页。先保存或复制备用，再离开，避免丢失刚写的内容。', [
    { label: '继续编辑', type: 'secondary', run: () => { closeModal(); log('回到编辑器，输入保留'); } },
    { label: '重试保存后离开', type: 'primary', run: () => { draftDirty = false; closeModal(true); onLeave(); toast('草稿已保存到手机'); } },
  ], true); log('仅在离开时要求决定，不清除内容');
}
const renderers = {
  copy(auto) {
    $('#app').innerHTML = header('知识库', '随时记下，再慢慢整理。') + `<article class="reader"><p class="meta">本机笔记 · 演示内容</p><h3>把反馈放回任务里</h3><p>好的提示，让人看见结果，也能继续手里的工作。</p><p>复制成功轻轻确认；需要处理的问题，就留在发生问题的地方。</p>${action('copy-content', '复制内容', 'copy')}</article>`;
    $('#copy-content').onclick = () => toast('已复制内容'); if (auto) toast('已复制内容');
  },
  field() {
    $('#app').innerHTML = header('设备', '连接电脑，让工作随身。') + `<form class="form-panel" id="join-form"><h3>凭接入码连接</h3><label class="field-label" for="code">电脑提供的接入码</label><input class="field" id="code" placeholder="输入接入码" aria-describedby="code-help" autocomplete="off"><p class="field-help" id="code-help" aria-live="polite">演示接入码：PP-AB12-CD34</p><button class="primary full" type="submit">连接电脑</button></form><p class="hint">这里只检查示例输入，不会发起真实连接。</p>`;
    $('#code').oninput = () => { $('#code').removeAttribute('aria-invalid'); $('#code-help').dataset.error = 'false'; $('#code-help').textContent = '演示接入码：PP-AB12-CD34'; };
    $('#join-form').onsubmit = event => { event.preventDefault(); if ($('#code').value.trim().toUpperCase() !== 'PP-AB12-CD34') { $('#code').setAttribute('aria-invalid', 'true'); $('#code-help').dataset.error = 'true'; $('#code-help').textContent = '接入码不完整，请核对电脑提供的内容。'; $('#code').focus(); log('只标记出错字段；输入保留'); } else { toast('接入码已通过校验'); log('示例校验成功，没有发起网络请求'); } };
  },
  background() {
    $('#app').innerHTML = header('设备', '连接电脑，让工作随身。') + '<div id="background-status"></div>' + deviceList(true) + action('persistent-error', '模拟持续检查失败', 'refresh');
    $('#connect-device').onclick = () => setScene('connection');
    $('#persistent-error').onclick = () => {
      $('#background-status').innerHTML = notice('warning', '在线状态暂时无法更新', '已配对设备仍保留。可以重新检查，也可直接尝试连接。', action('check-again', '重新检查'));
      log('持续失败才升级为一条提示，不锁住页面');
      $('#check-again').onclick = () => { $('#check-again').disabled = true; $('#check-again').textContent = '正在检查…'; later(() => { $('#background-status').innerHTML = ''; $('.device-copy small').innerHTML = '<i class="dot"></i>在线 · Windows'; log('状态已恢复；不追加“网络恢复”通知'); }, 1000); };
    };
  },
  connection() {
    $('#app').innerHTML = header('工作电脑', '远程会话', action('return-devices', '返回设备', 'back')) + `<div id="connection-status">${notice('warning', '画面暂时中断，输入已暂停', '正在保留会话。恢复正常画面后才能继续操作。', action('reconnect', '重新连接', 'refresh'))}</div><div class="remote-screen"><div class="remote-toolbar"><span>工作电脑 · Windows</span><span id="frame-status">最后一帧已过期</span></div><div class="remote-placeholder">${icon('monitor')}<p>画面恢复前，不向电脑发送输入。</p></div></div><div class="remote-inputs"><button class="secondary" id="pointer" disabled type="button">触控操作</button><button class="secondary" id="keyboard" disabled type="button">键盘输入</button></div>`;
    $('#return-devices').onclick = () => setScene('background');
    $('#reconnect').onclick = () => {
      $('#connection-status').innerHTML = notice('pending', '正在恢复连接…', '输入仍暂停，等待正常画面。', action('cancel-connect', '取消恢复'));
      $('#cancel-connect').onclick = () => setScene('background'); log('恢复中；提示原位更新，不叠加');
      later(() => { $('#connection-status').innerHTML = notice('success', '连接已恢复', '已收到正常画面，可以继续操作。'); $('#frame-status').textContent = '正常画面 · 示例'; $('.remote-placeholder p').textContent = '示例画面已恢复，触控和键盘可以继续使用。'; $('#pointer').disabled = false; $('#keyboard').disabled = false; $('#pointer').onclick = () => toast('触控操作已就绪'); $('#keyboard').onclick = () => toast('键盘输入已就绪'); log('只在画面恢复后解锁输入'); }, 1600);
    };
  },
  batch() {
    failedFiles = new Set([3, 4]); renderBatch();
  },
  draft() {
    draftDirty = true;
    $('#app').innerHTML = header('新建笔记', '输入保留在编辑器。', action('leave-editor', '返回', 'back')) + `<div class="editor"><label class="field-label" for="draft-title">标题</label><input id="draft-title" value="把反馈放回任务里"><label class="field-label" for="draft-content">正文</label><textarea id="draft-content"></textarea><p class="editor-status" id="draft-status">草稿尚未保存</p></div><div id="draft-feedback"></div><button id="save-draft" type="button" class="primary full">保存到手机</button><p class="hint">第一次模拟保存失败，重试会模拟保存成功。</p>`;
    $('#draft-content').value = draftText; $('#draft-content').oninput = () => { draftText = $('#draft-content').value; draftDirty = true; $('#draft-status').textContent = '内容有新修改，尚未保存'; };
    let attempts = 0;
    $('#save-draft').onclick = () => {
      const button = $('#save-draft'); button.disabled = true; button.textContent = '正在保存…';
      later(() => { button.disabled = false; if (++attempts === 1) { $('#draft-feedback').innerHTML = notice('error', '内容尚未保存', '输入仍在，请重试保存，也可以先复制内容备用。', action('copy-draft', '复制内容备用', 'copy')); $('#copy-draft').onclick = () => toast('已复制内容备用'); button.textContent = '重试保存到手机'; log('保存失败；输入保留，编辑器不关闭'); } else { draftDirty = false; $('#draft-feedback').innerHTML = ''; $('#draft-status').textContent = '草稿已保存到手机'; button.textContent = '保存到手机'; log('保存成功，在原位确认，不追加大横幅'); } }, 600);
    };
    $('#leave-editor').onclick = () => draftDirty ? leaveDraft(() => setScene('copy', false)) : setScene('copy', false);
  },
  danger() {
    $('#app').innerHTML = header('设置', '管理手机端偏好与记录。') + `<h3 class="group-label">连接历史</h3><div class="group" id="history"><div class="setting-row">工作电脑<span>今天 09:20</span></div><div class="setting-row">家里的电脑<span>昨天 21:35</span></div></div><p class="hint">清空只移除历史记录，不删除已配对设备。</p><button class="destructive full" id="clear-history" type="button">清空历史记录</button>`;
    $('#clear-history').onclick = () => { modal('清空历史记录？', '这台手机上的连接历史将被移除，清空后无法恢复。已配对设备不受影响。', [
      { label: '取消', type: 'secondary', run: () => { closeModal(); log('已取消，历史记录保留'); } },
      { label: '清空历史记录', type: 'destructive', run: () => { closeModal(); $('#history').innerHTML = '<div class="setting-row">历史记录已清空</div>'; $('#clear-history').disabled = true; log('示例记录已清空；原位显示结果'); } },
    ]); log('聚焦取消；只有明确点击才清空示例'); };
  },
  priority() {
    $('#app').innerHTML = header('文件', '和电脑互传文件。') + '<h3 class="group-label">接收位置</h3><div class="group"><div class="setting-row">接收目录<span>授权已失效</span></div></div>' + `<div id="permission">${notice('error', '无法接收文件', '接收目录授权已失效。发送文件和其他功能仍可使用。', action('fix-directory', '重新选择接收位置'))}</div><button class="secondary full" id="repeat-failure" type="button">重复触发同一故障</button><button class="text-button full" id="ordinary-success" type="button">模拟复制成功</button><p class="hint" id="local-success"></p>`;
    let attempts = 1;
    $('#repeat-failure').onclick = () => log(`同一故障第 ${++attempts} 次触发：仍只保留一条提示`);
    $('#ordinary-success').onclick = () => { $('#local-success').textContent = '内容已复制'; log('普通成功原位反馈；目录错误仍可见'); };
    $('#fix-directory').onclick = () => { $('#permission').innerHTML = notice('success', '接收位置已恢复', '可以继续接收文件。'); $('.setting-row span').textContent = '本机接收目录'; $('#repeat-failure').disabled = true; log('故障解决后才能更新持久状态'); };
  },
};
function renderBatch() {
  const names = ['会议纪要.pdf', '项目截图.png', '需求说明.docx', '附件照片.jpg', '设计参考.zip'];
  $('#app').innerHTML = header('文件', '和电脑互传文件。') + `<div id="batch-summary">${notice(failedFiles.size ? 'warning' : 'success', failedFiles.size ? `${5 - failedFiles.size} 个文件已完成，${failedFiles.size} 个未完成` : '5 个文件已完成', failedFiles.size ? '已完成的文件可正常使用，只需处理未完成项。' : '本批传输已完成。', failedFiles.size ? action('retry-all', '重试未完成项') : '')}</div><h3 class="group-label">本批传输</h3><div class="group">${names.map((name, i) => `<div class="task-row" data-failed="${failedFiles.has(i)}"><span class="status-icon">${icon('file')}</span><div class="task-copy"><strong>${name}</strong><small>${failedFiles.has(i) ? '传输中断 · 可重试' : '已完成'}</small></div>${failedFiles.has(i) ? `<button type="button" class="text-button" data-retry="${i}">重试</button>` : icon('check', 'class="done"')}</div>`).join('')}</div>`;
  const retry = (indices, button) => { button.disabled = true; button.textContent = '重试中…'; log('只重试未完成项，成功项保持不变'); later(() => { indices.forEach(i => failedFiles.delete(i)); renderBatch(); log(failedFiles.size ? `${failedFiles.size} 个文件仍未完成` : '本批传输完成，摘要原位更新'); }, 1000); };
  $('#retry-all')?.addEventListener('click', event => retry([...failedFiles], event.currentTarget));
  document.querySelectorAll('[data-retry]').forEach(button => button.onclick = () => retry([Number(button.dataset.retry)], button));
}
$('#scenario-list').innerHTML = Object.entries(scenes).map(([id, scene]) => `<button type="button" class="scene-button" data-scene="${id}" aria-pressed="false">${icon(scene.icon)}<span><strong>${scene.title}</strong><small>${scene.short}</small></span></button>`).join('');
document.querySelectorAll('.scene-button').forEach(button => button.onclick = () => setScene(button.dataset.scene));
$('#replay').onclick = () => setScene(current);
$('#theme').onclick = () => { const dark = document.documentElement.dataset.theme !== 'dark'; document.documentElement.dataset.theme = dark ? 'dark' : 'light'; $('#theme').textContent = dark ? '切换浅色' : '切换深色'; };
$('#reduce').onchange = () => { document.documentElement.dataset.reduce = String($('#reduce').checked); if (reduced()) { motionFrames.forEach(cancelAnimationFrame); motionFrames.clear(); document.querySelectorAll('.snackbar, .confirm-sheet').forEach(el => el.style.transform = 'none'); } };
document.addEventListener('visibilitychange', () => { document.documentElement.dataset.hidden = String(document.hidden); if (document.hidden) { motionFrames.forEach(cancelAnimationFrame); motionFrames.clear(); document.querySelectorAll('.snackbar, .confirm-sheet').forEach(el => el.style.transform = 'none'); } updateNoticeClock(); });
const initial = location.hash.slice(1); setScene(scenes[initial] ? initial : 'copy');
