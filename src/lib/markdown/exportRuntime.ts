/**
 * 导出文件里内嵌的表单运行时（**字符串源码**，不能 import 任何东西）。
 *
 * 职责：回填上次填写 → 输入即存 → 「下载已填版本」把值烧回文件。
 *
 * 为什么是「下载已填版本」而不是「保存回原文件」：
 * 浏览器在 `file://` 下不允许回写打开的本地文件（`showSaveFilePicker` 实测直接
 * AbortError），所以唯一的可靠出口是把当前值序列化进一份新 HTML 再下载。
 *
 * 为什么同时保留 localStorage：
 * 它能在「同一个浏览器再次打开同一个文件」时免操作地恢复，比每次下载顺手。
 * 但它在 file:// 下的可靠性因浏览器而异——Chrome/Edge 可用（且所有本地文件共享
 * 同一 origin，所以 key 必须带文档 id）；**Firefox / Safari 直接抛 SecurityError**。
 * 因此这里首屏探测一次，失败就把状态条改成明确的警告，绝不假装存上了。
 */

export const EXPORT_RUNTIME = String.raw`(function () {
  "use strict";
  var dataEl = document.getElementById("pp-data");
  var data = {};
  try { data = JSON.parse(dataEl ? dataEl.textContent || "{}" : "{}"); } catch (e) { data = {}; }
  var DOC_ID = data.docId || "unknown";
  var KEY = "pp-form:" + DOC_ID;
  var stateEl = document.getElementById("pp-state");
  var toastEl = document.getElementById("pp-toast");
  var root = document.querySelector("[data-pp-root]");
  if (!root) return;

  function canStore() {
    try {
      localStorage.setItem(KEY + ":probe", "1");
      localStorage.removeItem(KEY + ":probe");
      return true;
    } catch (e) { return false; }
  }
  var STORE_OK = canStore();

  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function state(text, warn) {
    if (!stateEl) return;
    stateEl.textContent = text;
    if (warn) stateEl.setAttribute("data-warn", "1");
    else stateEl.removeAttribute("data-warn");
  }
  var toastTimer = null;
  function toast(text) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.setAttribute("data-on", "1");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.removeAttribute("data-on"); }, 1800);
  }

  function controls() {
    var all = root.querySelectorAll("input[name], textarea[name], select[name]");
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.hasAttribute("data-task-i")) continue;
      var t = (el.getAttribute("type") || "").toLowerCase();
      if (t === "submit" || t === "button" || t === "reset" || t === "image" || t === "file") continue;
      out.push(el);
    }
    return out;
  }
  function kindOf(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === "textarea") return "textarea";
    if (tag === "select") return "select";
    return (el.getAttribute("type") || "text").toLowerCase();
  }

  function readValues() {
    var out = {};
    var list = controls();
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      var n = el.getAttribute("name");
      if (!n) continue;
      var k = kindOf(el);
      if (k === "checkbox") out[n] = !!el.checked;
      else if (k === "radio") { if (el.checked) out[n] = el.value; }
      else out[n] = el.value;
    }
    return out;
  }

  function applyValues(v) {
    if (!v) return;
    var list = controls();
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      var n = el.getAttribute("name");
      if (!n || !(n in v)) continue;
      var k = kindOf(el);
      if (k === "checkbox") el.checked = !!v[n];
      else if (k === "radio") el.checked = el.value === String(v[n]);
      else el.value = v[n] == null ? "" : String(v[n]);
    }
  }

  var initial = data.values || {};
  var stored = null;
  if (STORE_OK) {
    try { stored = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { stored = null; }
  }
  applyValues(stored || initial);
  if (!STORE_OK) state("本机不支持自动保存，请用「下载已填版本」", true);
  else if (stored) state("已恢复上次填写");
  else state(controls().length ? "填写内容会自动保存在本机浏览器" : "无可填字段");

  var timer = null;
  function save() {
    if (!STORE_OK) return;
    try {
      localStorage.setItem(KEY, JSON.stringify(readValues()));
      state("已自动保存 " + pad(new Date().getHours()) + ":" + pad(new Date().getMinutes()));
    } catch (e) {
      STORE_OK = false;
      state("本机不支持自动保存，请用「下载已填版本」", true);
    }
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 400);
  }
  root.addEventListener("input", schedule, true);
  root.addEventListener("change", schedule, true);

  /** 把当前值同步回 HTML 属性，否则 outerHTML 里还是导出时的初始值 */
  function syncAttributes() {
    var list = controls();
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      var k = kindOf(el);
      if (k === "checkbox" || k === "radio") {
        if (el.checked) el.setAttribute("checked", "checked");
        else el.removeAttribute("checked");
      } else if (k === "select") {
        for (var j = 0; j < el.options.length; j++) {
          if (el.options[j].selected) el.options[j].setAttribute("selected", "selected");
          else el.options[j].removeAttribute("selected");
        }
      } else if (k === "textarea") {
        el.textContent = el.value;
      } else {
        el.setAttribute("value", el.value);
      }
    }
  }

  function download() {
    var values = readValues();
    syncAttributes();
    if (dataEl) {
      var json = JSON.stringify({ docId: DOC_ID, values: values });
      dataEl.textContent = json
        .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
    }
    if (toastEl) toastEl.removeAttribute("data-on");
    var html = "<!doctype html>\n" + document.documentElement.outerHTML;
    var name = (document.title || "文档").replace(/[\\/:*?"<>|]/g, "-");
    var d = new Date();
    var stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
    var blob = new Blob([html], { type: "text/html;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = name + "-已填-" + stamp + ".html";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    toast("已下载填好的文件");
    state("已导出，共 " + Object.keys(values).length + " 个字段");
  }

  function toPlainText() {
    var values = readValues();
    var lines = [];
    var seen = {};
    var list = controls();
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      var n = el.getAttribute("name");
      if (!n || seen[n]) continue;
      seen[n] = 1;
      var label = el.getAttribute("placeholder") || el.getAttribute("aria-label") || n;
      var k = kindOf(el);
      var v = k === "checkbox" ? (values[n] ? "是" : "否") : (values[n] == null ? "" : String(values[n]));
      lines.push("- " + label + "：" + v);
    }
    return lines.join("\n");
  }

  function copy() {
    var text = toPlainText();
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); toast("已复制填写结果"); }
      catch (e) { toast("复制失败，请手动选择"); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast("已复制填写结果");
      }).catch(fallback);
    } else {
      fallback();
    }
  }

  var bar = document.querySelector(".pp-bar");
  if (bar) {
    bar.addEventListener("click", function (e) {
      var btn = e.target && e.target.closest ? e.target.closest("[data-pp]") : null;
      if (!btn) return;
      var act = btn.getAttribute("data-pp");
      if (act === "download") download();
      else if (act === "copy") copy();
    });
  }
})();`;
