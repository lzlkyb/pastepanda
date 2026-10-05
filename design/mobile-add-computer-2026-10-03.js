const icons = {
  scan: '<path d="M4 7V4h3m10 0h3v3M20 17v3h-3M7 20H4v-3M7 12h10"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  shield: '<path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m9 12 2 2 4-4"/>',
  close: '<path d="m18 6-12 12M6 6l12 12"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  settings: '<path d="M12 3v4m0 10v4M3 12h4m10 0h4M5.6 5.6l2.8 2.8m7.2 7.2 2.8 2.8M5.6 18.4l2.8-2.8m7.2-7.2 2.8-2.8"/><circle cx="12" cy="12" r="4"/>',
  key: '<circle cx="8" cy="8" r="5"/><path d="m12 12 9 9m-4-4 3-3m-6 0 3-3"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
  camera: '<path d="M14.5 4h-5L7 7H3a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-4Z"/><circle cx="12" cy="13" r="3"/>',
  wifi: '<path d="M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0M8 16a6 6 0 0 1 8 0M12 20h.01"/>',
};
const icon = (name) => `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24">${icons[name]}</svg>`;
const concepts = {
  A: { title: "A · 精简原布局", description: "保留输码为主的习惯。整理输入区与按钮层级，把本机码放到下方，改动最小。" },
  B: { title: "B · 扫码与输码", description: "推荐。扫码入口容易找到，8 位码仍在同一屏直接输入。低频的本机码出示收在下方。" },
  C: { title: "C · 双入口页签", description: "扫码与输码各有独立空间，页面更安静。手动输入需要先切换页签。" },
};
const states = { A: "idle", B: "idle", C: "idle" };
const modes = { A: "code", B: "code", C: "scan" };
const values = { A: "", B: "", C: "" };
let selected = "B";
const primary = (text, action, disabled = false) => `<button class="primary" data-action="${action}" ${disabled ? "disabled" : ""}>${text}</button>`;
const secondary = (text, action) => `<button class="secondary" data-action="${action}">${text}</button>`;
function background() {
  return `<div class="statusbar"><span>9:41</span><span class="signal">${icon("wifi")}</span></div>
    <div class="device-page"><div class="device-header"><h2>设备</h2><button data-action="reopen">添加</button></div><p>连接电脑，让工作随身。</p>
    <div class="channel"><div><strong>正在检查远程通道…</strong><small>0 台已配对设备</small></div>${icon("shield")}</div>
    <div class="device-actions">${secondary(`${icon("scan")}添加电脑`, "reopen")}${secondary(`${icon("key")}无人值守`, "noop")}</div>
    <div class="section-label">已配对设备</div><div class="empty">${icon("monitor")}<h3>还没有配对的电脑</h3><p>在电脑端打开远程电脑，<br>扫码或输入配对码，即可开始。</p></div></div>
    <div class="nav"><span class="selected">${icon("monitor")}设备</span><span>${icon("folder")}文件</span><span>${icon("settings")}设置</span></div>`;
}
function advanced() {
  return `<div class="advanced"><button data-action="own"><span class="own-label">${icon("phone")}出示本机配对码</span>${icon("chevron")}</button></div>`;
}
function input(id) {
  const valid = values[id].replace(/\D/g, "").length === 8;
  return `<label class="entry-field"><span>电脑的配对码</span><input class="code-input" aria-label="电脑的 8 位配对码" inputmode="numeric" autocomplete="off" maxlength="12" placeholder="输入 8 位配对码" value="${values[id]}" /><small>输入电脑上显示的码，支持粘贴。</small></label>${primary("开始配对", "pair", !valid)}`;
}
function notice() {
  return `<div class="notice" role="alert"><div class="notice-head">${icon("alert")}<strong>配对未能完成</strong></div><p>配对码已过期，请在电脑端获取新码后重试。</p></div>`;
}
function content(id) {
  const state = states[id];
  if (state === "waiting") return `<div class="waiting"><span class="waiting-icon">${icon("monitor")}</span><h4>正在完成配对</h4><p>电脑端保持配对码页面打开，<br>完成后会自动返回设备列表。</p></div><div class="wait-detail">已找到「示例电脑」，正在建立配对。</div>${secondary("取消配对", "back")}`;
  if (state === "own") return `<h4 class="own-heading">在电脑端输入这枚码</h4><p class="own-caption">使用电脑端的“输入配对码”，与这台手机配对。</p><span class="own-code" aria-label="本机示例配对码">4826 1093</span><p class="expiry">示例码 · 04:52 后到期</p><img class="qr" src="mobile-add-computer-2026-10-03-qr.svg" alt="本机示例配对码的二维码" /><div class="own-actions">${primary("等待对方连接", "pair")}${secondary("隐藏配对码", "back")}</div>`;
  if (state === "scan" || state === "denied") return `<div class="camera" aria-label="扫码取景示意">${icon("camera")}<div class="scan-frame"></div></div><p class="scan-caption">把电脑上的配对二维码放进取景框</p>${state === "denied" ? `<div class="notice" role="alert"><div class="notice-head">${icon("alert")}<strong>暂时无法使用摄像头</strong></div><p>请允许摄像头权限，或返回输入配对码。</p></div>${secondary("重新尝试扫码", "scan")}` : ""}${secondary("返回输入配对码", "code")}`;
  const intro = `<p class="intro">在电脑端打开<strong>配对码页面</strong>，<br>扫码或输入 8 位码即可添加。</p>`;
  let form;
  if (id === "A") form = `${input(id)}<button class="secondary scan-plain" data-action="scan">${icon("scan")}扫一扫添加</button>`;
  if (id === "B") form = `<button class="scan-entry" data-action="scan">${icon("scan")}<span class="copy"><strong>扫一扫添加</strong><small>扫描电脑上的配对二维码</small></span>${icon("chevron")}</button><div class="divider">或输入配对码</div>${input(id)}`;
  if (id === "C") form = `<div class="mode-tabs" role="tablist" aria-label="添加方式"><button role="tab" data-action="scan-mode" aria-selected="${modes.C === "scan"}">扫码添加</button><button role="tab" data-action="code" aria-selected="${modes.C === "code"}">输入配对码</button></div>${modes.C === "code" ? input(id) : `<div class="scan-choice">${icon("scan")}<h4>用手机扫一扫</h4><p>对准电脑上的配对二维码，<br>不用手动输入。</p></div>${primary("打开扫一扫", "scan")}`}`;
  return `${intro}${form}${state === "error" ? notice() : ""}${advanced()}`;
}
function render() {
  document.querySelector("#comparison").innerHTML = Object.entries(concepts).map(([id, concept]) => `<article class="concept variant-${id}" data-id="${id}" data-selected="${selected === id}"><div class="concept-heading"><h2>${concept.title}</h2>${id === "B" ? '<span class="recommended">推荐</span>' : ""}</div><div class="phone">${background()}${states[id] === "closed" ? secondary("重新打开添加电脑", "reopen").replace('class="secondary"', 'class="secondary reopen"') : `<div class="scrim"></div><section class="sheet" role="dialog" aria-label="${id} 方案：添加电脑"><div class="handle"></div><header class="sheet-head"><h3>添加电脑</h3><button class="close" data-action="close">${icon("close")}关闭</button></header><div class="sheet-body">${content(id)}</div></section>`}</div><p class="description">${concept.description}</p></article>`).join("");
}
document.querySelector("#comparison").addEventListener("input", (event) => {
  if (!event.target.matches(".code-input")) return;
  const id = event.target.closest(".concept").dataset.id;
  const digits = event.target.value.replace(/^(?:PP[- ]?)/i, "").replace(/[\s-]/g, "").replace(/\D/g, "").slice(0, 8);
  values[id] = digits.length > 4 ? `${digits.slice(0, 4)} ${digits.slice(4)}` : digits;
  event.target.value = values[id];
  event.target.closest(".sheet-body").querySelector('[data-action="pair"]').disabled = digits.length !== 8;
  event.target.closest(".sheet-body").querySelector(".notice")?.remove();
});
document.querySelector("#comparison").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button || button.disabled) return;
  const id = button.closest(".concept").dataset.id;
  const action = button.dataset.action;
  if (action === "noop") return;
  if (action === "code") { modes[id] = "code"; states[id] = "idle"; }
  if (action === "scan-mode") { modes[id] = "scan"; states[id] = "idle"; }
  if (action === "pair") states[id] = "waiting";
  if (action === "scan" || action === "own") states[id] = action;
  if (action === "back" || action === "reopen") states[id] = "idle";
  if (action === "close") states[id] = "closed";
  render();
});
document.querySelector("#state").addEventListener("change", (event) => {
  for (const id of Object.keys(states)) {
    states[id] = event.target.value === "ready" ? "idle" : event.target.value;
    if (event.target.value === "ready" || event.target.value === "error") { values[id] = "4826 1093"; modes[id] = "code"; }
    if (event.target.value === "idle") { values[id] = ""; modes.C = "scan"; }
  }
  render();
});
document.querySelectorAll("[data-pick]").forEach((button) => button.addEventListener("click", () => {
  selected = button.dataset.pick;
  document.querySelectorAll("[data-pick]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
  render();
}));
document.querySelector("#theme").addEventListener("change", (event) => { document.documentElement.dataset.theme = event.target.value; });
render();
