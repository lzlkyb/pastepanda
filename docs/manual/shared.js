/* PastePanda 文档站 · 两页共享脚本
 *
 * 只放两件事：主题切换（含 localStorage 记忆）与目录滚动高亮。
 * 宣传页的八个演示舞台播放引擎是宣传页独占，留在 index.html 里，不进这里。
 *
 * ❗ 两页必须共用同一个 localStorage 键 pp-manual-theme，
 *   否则在宣传页切了主题、跳到手册页又变回默认色。
 */
var THEME_NAMES = { ocean: "经典白", "ocean-dark": "深海", midnight: "午夜", forest: "森林", blossom: "美乐蒂", dawn: "晨曦" };
function setTheme(key) {
  document.documentElement.setAttribute("data-theme", key);
  try { localStorage.setItem("pp-manual-theme", key); } catch (e) {}
}
(function () {
  var sel = document.getElementById("themeBtn");
  var key = "ocean";
  try {
    var saved = localStorage.getItem("pp-manual-theme");
    if (saved && THEME_NAMES[saved]) key = saved;
  } catch (e) {}
  document.documentElement.setAttribute("data-theme", key);
  if (sel) sel.value = key;
})();

/* 目录滚动高亮：只有手册页有 nav.toc，宣传页这段自然空转。 */
(function () {
  var links = [].slice.call(document.querySelectorAll("nav.toc a[href^='#']"));
  if (!links.length) return;
  var secs = links.map(function (a) { return document.querySelector(a.getAttribute("href")); });
  var obs = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) {
        var id = "#" + e.target.id;
        links.forEach(function (l) { l.classList.toggle("active", l.getAttribute("href") === id); });
      }
    });
  }, { rootMargin: "-20% 0px -70% 0px" });
  secs.forEach(function (s) { if (s) obs.observe(s); });
})();
