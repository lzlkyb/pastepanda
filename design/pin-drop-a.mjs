const $ = id => document.getElementById(id);
const stage = $("stage"), pin = $("pin"), zone = $("input-zone"), ghost = $("ghost");
let gesture = null;
let suppressHandleClick = false;
let position = { x: 24, y: 145 };

function feedback(text, tone = "", copy = false) {
  $("feedback-text").textContent = text;
  $("pin-feedback").dataset.tone = tone;
  $("flow-status").textContent = text;
  $("flow-status").dataset.tone = tone;
  $("copy").hidden = !copy;
}
function placePin() {
  pin.style.left = position.x + "px";
  pin.style.top = position.y + "px";
}
function coordinates(event) {
  const rect = stage.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}
function overInput(event) {
  const rect = zone.getBoundingClientRect();
  return !$("chat").hidden && event.clientX >= rect.left && event.clientX <= rect.right
    && event.clientY >= rect.top && event.clientY <= rect.bottom;
}
function targetState(event) {
  const inside = overInput(event);
  const accepted = inside && $("scenario").value === "accept";
  zone.classList.toggle("accept", accepted);
  zone.classList.toggle("reject", inside && !accepted);
  ghost.dataset.accept = String(accepted);
  $("ghost-status").textContent = accepted ? "复制原图 · 松开交付" : inside ? "此处不支持图片拖入" : "此处不可放置";
  $("zone-title").textContent = accepted ? "松开鼠标，交付原图" : inside ? "不支持图片拖入" : "拖到这里，松开鼠标";
}
function cleanup() {
  if (gesture?.element.hasPointerCapture(gesture.id)) gesture.element.releasePointerCapture(gesture.id);
  gesture = null;
  ghost.hidden = true;
  pin.classList.remove("moving");
  zone.classList.remove("accept", "reject");
  $("zone-title").textContent = $("scenario").value === "reject" ? "当前输入区不支持拖入" : "拖到这里，松开鼠标";
}
function deliver(inside) {
  if ($("scenario").value === "closed") {
    feedback("目标窗口已关闭 · 原贴图保留，可重新拖入。", "error", true);
  } else if (inside && $("scenario").value === "accept") {
    $("attachment").hidden = false;
    $("empty-input").hidden = true;
    $("zone-state").textContent = "等待用户确认";
    feedback("图片已交给应用处理 · 原贴图保留。", "success");
  } else {
    feedback(inside ? "此处不支持图片拖入 · 可右键复制后粘贴。" : "未交付图片 · 松开位置不可接收，可重试。", "error", true);
  }
}
function begin(event, mode) {
  if (event.button !== 0 || gesture) return;
  const point = coordinates(event);
  const element = mode === "rope" ? stage : event.currentTarget;
  gesture = { mode, id: event.pointerId, element, start: point, origin: { ...position }, moved: false, detached: false };
  element.setPointerCapture(event.pointerId);
  event.preventDefault();
}
function move(event) {
  if (!gesture || event.pointerId !== gesture.id) return;
  const point = coordinates(event);
  const dx = point.x - gesture.start.x, dy = point.y - gesture.start.y;
  if (!gesture.moved && Math.hypot(dx, dy) < 4) return;
  gesture.moved = true;
  if (gesture.mode === "rope" && !gesture.detached) {
    if (Math.abs(dy) <= 36 && Math.abs(dx) <= 120) {
      $("hang-photo").style.transform = `translate(${dx}px,${dy}px)`;
      feedback("仍在绳带内 · 拉离绳带后取下。");
      return;
    }
    gesture.detached = true;
    $("rope").hidden = true;
    $("scene-note").textContent = "其它应用前台模拟 · 晾衣绳隐藏 · 正在连续拖入";
  }
  if (gesture.mode === "move") {
    pin.classList.add("moving");
    position = {
      x: Math.max(8, Math.min(stage.clientWidth - 488, gesture.origin.x + dx)),
      y: Math.max(48, Math.min(stage.clientHeight - 380, gesture.origin.y + dy))
    };
    placePin();
    feedback("正在移动贴图 · 图片不会交给其它应用。");
  } else {
    ghost.hidden = false;
    ghost.style.left = Math.max(0, Math.min(stage.clientWidth - 180, point.x + 16)) + "px";
    ghost.style.top = Math.max(0, Math.min(stage.clientHeight - 110, point.y + 16)) + "px";
    targetState(event);
    feedback("正在拖入应用 · 松开交付，Esc 取消。");
  }
}
function end(event) {
  if (!gesture || event.pointerId !== gesture.id) return;
  const { mode, moved } = gesture;
  const detached = gesture.detached;
  suppressHandleClick = mode === "transfer" && moved;
  const inside = overInput(event);
  cleanup();
  if (mode === "move" && moved) feedback("位置已调整 · 原图尺寸不变。");
  else if (mode === "transfer" && moved) deliver(inside);
  else if (mode === "rope" && detached) {
    pin.hidden = false; $("flow-status").hidden = true;
    deliver(inside);
    if (!inside || $("scenario").value !== "accept") {
      const point = coordinates(event);
      position = {x: Math.max(8,Math.min(stage.clientWidth-488,point.x-24)),y: Math.max(48,Math.min(stage.clientHeight-380,point.y-24))};
      placePin();
    }
    $("scene-note").textContent = "取下后保留原尺寸贴图 · 普通拖动只移动位置";
  }
  else if (mode === "rope") {
    $("hang-photo").style.transform = "";
    feedback("按住照片拉离绳带，再继续拖入输入区。");
  }
  else if (mode === "transfer") feedback("按住「拖入应用」并拖到输入区，再松开。");
}
function cancel() {
  if (!gesture) return;
  const mode = gesture.mode;
  const detached = gesture.detached;
  if (mode === "move") { position = gesture.origin; placePin(); }
  cleanup();
  if (mode === "rope") {
    $("hang-photo").style.transform = "";
    if (detached) { pin.hidden = false; $("flow-status").hidden = true; }
  }
  feedback(mode === "move" ? "已取消移动 · 已恢复原位置。" : mode === "rope" && !detached ? "已取消取下 · 照片仍在绳上。" : "已取消拖入 · 原贴图保留。");
}
function clearAttachment() {
  $("attachment").hidden = true;
  $("empty-input").hidden = false;
  $("zone-state").textContent = $("scenario").value === "reject" ? "不支持接收" : "图片接收区";
}
$("photo").addEventListener("pointerdown", event => begin(event, "move"));
$("hang-photo").addEventListener("pointerdown", event => begin(event, "rope"));
$("handle").addEventListener("pointerdown", event => begin(event, "transfer"));
document.addEventListener("pointermove", move);
document.addEventListener("pointerup", end);
document.addEventListener("pointercancel", cancel);
window.addEventListener("blur", cancel);
document.addEventListener("keydown", event => { if (event.key === "Escape") cancel(); });
$("handle").addEventListener("click", () => {
  if (suppressHandleClick) { suppressHandleClick = false; return; }
  if (!gesture) feedback("按住此手柄，拖到应用输入区；图片本体用于移动。");
});
$("scenario").addEventListener("change", () => {
  cancel();
  $("chat").hidden = $("scenario").value === "closed";
  $("closed-note").hidden = !$("chat").hidden;
  clearAttachment();
  cleanup();
  feedback(pin.hidden ? "接收状态已切换 · 可从绳上取下后继续拖入。" : "接收状态已切换 · 可按住手柄重新尝试。");
});
$("client").addEventListener("change", () => { $("client-name").textContent = $("client").value; clearAttachment(); });
$("remove").addEventListener("click", () => { clearAttachment(); feedback("已移除模拟待发送附件 · 原贴图保留。"); });
$("demo-drop").addEventListener("click", () => {
  $("rope").hidden = true; $("flow-status").hidden = true; pin.hidden = false;
  $("scene-note").textContent = "原图已交给模拟输入区 · 原贴图保留";
  deliver(true);
});
$("use-pin").addEventListener("click", () => {
  cancel(); $("rope").hidden = true; $("flow-status").hidden = true; pin.hidden = false;
  $("scene-note").textContent = "已有贴图 · 拖本体移动，拖手柄交付";
  feedback("按住「拖入应用」手柄拖到输入区。");
});
$("copy").addEventListener("click", () => feedback("演示：右键复制原图后，在输入区手动粘贴。"));
$("close-pin").addEventListener("click", () => { cancel(); pin.hidden = true; $("restore-pin").hidden = false; $("demo-drop").disabled = true; });
$("restore-pin").addEventListener("click", () => { pin.hidden = false; $("restore-pin").hidden = true; $("demo-drop").disabled = false; });
$("reset").addEventListener("click", () => {
  cancel();
  position = { x: 24, y: 145 }; placePin();
  pin.hidden = false; $("restore-pin").hidden = true; $("demo-drop").disabled = false;
  $("scenario").value = "accept"; $("chat").hidden = false; $("closed-note").hidden = true;
  clearAttachment(); cleanup(); feedback("拖图片移动；拖手柄交付原图。");
  pin.hidden = true; $("rope").hidden = false; $("flow-status").hidden = false;
  $("hang-photo").style.transform = "";
  $("scene-note").textContent = "桌面前台模拟 · 拉离绳带后连续拖入应用";
  feedback("原图 480 × 320 · 取下后继续拖动");
});
