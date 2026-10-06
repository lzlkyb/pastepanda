// Preview only: outcomes are simulated, never sent to a live computer.
const $ = selector => document.querySelector(selector);
const device = $('#device');
const panel = $('#panel');
let returnFocus;
let confirmedQuality = '自动';
let requestedQuality = '自动';
let generation = 0;
let pending = false;
let disconnected = false;
let noticeTimer;
const titles = { screen: '画面', mode: '操作方式', connection: '连接详情', keyboard: '键盘', more: '更多', file: '文件请求', end: '断开连接' };
function openPanel(name) {
  if (panel.hidden) returnFocus = document.activeElement;
  $('[data-content="' + name + '"]').hidden = false;
  document.querySelectorAll('[data-content]').forEach(el => { el.hidden = el.dataset.content !== name; });
  $('#panel-title').textContent = titles[name];
  panel.hidden = false;
  $('#backdrop').hidden = false;
  device.querySelector('.remote').inert = true;
  device.querySelector('.rail').inert = true;
  device.querySelector('.session-head').inert = true;
  $('#status-strip').inert = true;
  $('#close-panel').focus();
}
function closePanel() {
  panel.hidden = true;
  $('#backdrop').hidden = true;
  device.querySelector('.remote').inert = false;
  device.querySelector('.rail').inert = false;
  device.querySelector('.session-head').inert = false;
  $('#status-strip').inert = false;
  if (returnFocus?.isConnected && returnFocus.offsetParent) returnFocus.focus();
}
document.querySelectorAll('[data-panel]').forEach(el => el.addEventListener('click', () => openPanel(el.dataset.panel)));
$('#close-panel').onclick = closePanel;
$('#backdrop').onclick = closePanel;
$('#cancel-end').onclick = closePanel;
document.addEventListener('keydown', event => {
  if (panel.hidden) return;
  if (event.key === 'Escape') { event.preventDefault(); closePanel(); }
  if (event.key !== 'Tab') return;
  const controls = [...panel.querySelectorAll('button,input')].filter(el => !el.disabled && el.offsetParent);
  const first = controls[0]; const last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
function setLayout(layout) {
  device.dataset.layout = layout;
  ['landscape','portrait','small'].forEach(id => $('#' + id).setAttribute('aria-pressed', String(id === layout)));
  $('#rotate').firstChild.textContent = layout === 'landscape' ? '切换到竖屏' : '切换到横屏';
  $('#tools').hidden = false;
  $('#tools-toggle').textContent = '收起';
  $('#tools-toggle').setAttribute('aria-expanded', 'true');
}
['landscape','portrait','small'].forEach(id => { $('#' + id).onclick = () => setLayout(id); });
$('#rotate').onclick = () => { closePanel(); setLayout(device.dataset.layout === 'landscape' ? 'portrait' : 'landscape'); };
$('#theme').onclick = () => {
  const dark = device.dataset.theme !== 'dark';
  device.dataset.theme = dark ? 'dark' : 'light';
  $('#theme').setAttribute('aria-pressed', String(dark));
};
$('#large-text').onclick = () => {
  const large = device.dataset.largeText !== 'true';
  device.dataset.largeText = String(large);
  $('#large-text').setAttribute('aria-pressed', String(large));
};
$('#tools-toggle').onclick = () => {
  const showing = $('#tools').hidden;
  $('#tools').hidden = !showing;
  $('#tools-toggle').textContent = showing ? '收起' : '工具';
  $('#tools-toggle').setAttribute('aria-expanded', String(showing));
};
function notice(text, tone = 'info', action) {
  clearTimeout(noticeTimer);
  $('#status-strip').hidden = false;
  $('#status-strip').dataset.tone = tone;
  $('#status-text').textContent = text;
  $('#status-action').hidden = !action;
  $('#status-action').textContent = action?.label || '';
  $('#status-action').onclick = action?.run || null;
  // Only short, local outcomes expire. Connection problems remain discoverable.
  if (tone !== 'error') noticeTimer = setTimeout(() => { $('#status-strip').hidden = true; }, 4000);
}
$('#status-close').onclick = () => { clearTimeout(noticeTimer); $('#status-strip').hidden = true; };
function qualityFeedback(title, detail, tone, retry = false) {
  $('#quality-title').textContent = title;
  $('#quality-detail').textContent = detail;
  $('#quality-feedback').dataset.tone = tone;
  $('#quality-feedback').setAttribute('aria-busy', String(pending));
  $('#retry-quality').hidden = !retry;
}
function pickQuality(next) {
  if (next === confirmedQuality && !pending) {
    qualityFeedback('当前已经是' + next, '电脑已确认此档位，无需重复切换。', 'info');
    return;
  }
  requestedQuality = next;
  const current = ++generation;
  const fail = $('#fail-next').checked || disconnected;
  pending = true;
  qualityFeedback('正在应用' + next + '…', '当前生效：' + confirmedQuality + '。等待电脑确认。', 'info');
  setTimeout(() => {
    // Ignore stale outcomes when another choice supersedes this request.
    if (current !== generation) return;
    pending = false;
    if (fail) {
      qualityFeedback('未能切换到' + next, '仍使用' + confirmedQuality + '。检查连接后重试。', 'error', true);
      if (panel.hidden) notice('画质未切换，仍使用' + confirmedQuality, 'error', { label: '重试', run: () => { openPanel('screen'); pickQuality(requestedQuality); } });
      return;
    }
    confirmedQuality = next;
    document.querySelectorAll('[data-quality]').forEach(el => el.setAttribute('aria-checked', String(el.dataset.quality === next)));
    qualityFeedback('已切换到' + next, '电脑已确认。此处是模拟确认结果。', 'success');
    if (panel.hidden) notice('画质已切换到' + next, 'success');
  }, 1200);
}
document.querySelectorAll('[data-quality]').forEach(el => { el.onclick = () => pickQuality(el.dataset.quality); });
$('#retry-quality').onclick = () => pickQuality(requestedQuality);
$('#fit').onclick = () => { closePanel(); notice('已恢复完整画面', 'success'); };
document.querySelectorAll('[data-mode]').forEach(el => { el.onclick = () => {
  $('#mode-label').textContent = el.dataset.mode;
  document.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button === el)));
  closePanel(); notice('操作方式：' + el.dataset.mode, 'success');
}; });
function connectionState(failed) {
  disconnected = failed;
  device.dataset.disconnected = String(failed);
  $('#latency').textContent = failed ? '异常' : '8 ms';
  $('#connection-label').textContent = failed ? '连接' : '流畅';
  $('#connection-title').textContent = failed ? '连接暂时不可用' : '连接流畅';
  $('#connection-detail').textContent = failed ? '画面暂时无法更新，已暂停远程输入。检查网络后重试。' : '操作延时 8 ms。电脑画面和会话工具各占独立区域。';
  $('#reconnect').hidden = !failed;
  $('.head-status').textContent = failed ? '连接异常' : '8 ms · 流畅';
  if (failed) notice('连接异常，远程输入已暂停', 'error', { label: '处理', run: () => openPanel('connection') });
  else notice('连接已恢复', 'success');
}
$('#connection-test').onclick = () => connectionState(!disconnected);
$('#reconnect').onclick = () => { connectionState(false); closePanel(); };
$('#file-test').onclick = () => { $('#file-entry').hidden = false; $('#file-title').textContent = '1 个文件请求待确认'; };
function resolveFile(text) { $('#file-entry').hidden = true; $('#file-title').textContent = '没有待确认的文件请求'; closePanel(); notice(text, 'success'); }
$('#receive-file').onclick = () => resolveFile('已开始接收文件；进度可在文件页查看');
$('#reject-file').onclick = () => resolveFile('已拒绝文件请求');
$('#send-text').onclick = () => {
  const draft = $('#draft');
  $('#text-result').textContent = !draft.value.trim() ? '先输入要发送的文字' : disconnected ? '文字未能提交，草稿已保留' : '文字已发送，等待电脑显示（模拟）';
  if (draft.value.trim() && !disconnected) draft.value = '';
};
