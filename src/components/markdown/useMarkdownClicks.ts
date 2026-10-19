import { useEffect, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { handleAnchorClick } from "@/lib/markdown/headingAnchor";
import { normalizeExternalUrl } from "@/lib/markdown/linkTarget";
import { COPY_ICON } from "@/lib/markdown/renderHtml";
import { copyTableElement, flashTableButton } from "@/components/markdown/tableTools";

type ToggleTask = (index: number) => boolean | void;
type ZoomedState = { src: string; alt: string } | null;

/**
 * 预览容器内的点击事件委托（一次注册，html 变化无需重绑）：
 * 任务勾选 / 预览内锚点 / 复制表格 / 外链 / 块行号闪烁 / mermaid 编辑 / 图片放大 / 代码复制。
 *
 * 回调依赖（toggleRef / setZoomed）经 ref 或 setState 稳定身份传入，避免重绑。
 */
export function useMarkdownClicks(
  containerRef: RefObject<HTMLDivElement | null>,
  setZoomed: (z: ZoomedState) => void,
  toggleRef: RefObject<ToggleTask | undefined>,
): void {
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      // 任务列表勾选：先乐观翻转（不等 300ms 防抖，否则像「点了没反应」），
      // 再写回源码；写回返回 false 说明定位不可信，立刻回滚，不留假绿。
      const box = (e.target as HTMLElement).closest<HTMLInputElement>('input[type="checkbox"]');
      if (box && el.contains(box)) {
        // 只有任务勾选框才由委托接管：渲染器始终写 data-task-i（定位不可信时为 "-1"）。
        // 表单勾选框（{{x/勾选}}，无 data-task-i）必须保留原生切换——
        // 曾经一律 preventDefault，导致它在预览里勾不上，值也存不进表单回填。
        if (box.dataset.taskI === undefined) return;
        e.preventDefault(); // 原生切换由我们接手，否则会与回写后的重渲染打架
        const cb = toggleRef.current;
        const idx = Number(box.dataset.taskI);
        if (!cb || !Number.isInteger(idx) || idx < 0) return;
        const next = !box.checked;
        box.checked = next;
        if (cb(idx) === false) box.checked = !next;
        return;
      }
      // 预览内锚点：`#章节` / 标题旁「#」→ 容器内滚动（不能靠原生 hash，会滚 window）
      const anchor = (e.target as HTMLElement).closest('a[href^="#"]') as HTMLAnchorElement | null;
      if (anchor && el.contains(anchor)) {
        e.preventDefault();
        handleAnchorClick(el, anchor);
        return;
      }
      // 表格右上角「复制表格」：同时写 text/html + text/plain，
      // 贴 Excel 得单元格、贴 Word 得排版（见 tableTools.copyTableElement）
      const tblBtn = (e.target as HTMLElement).closest(".md-tblcopy") as HTMLButtonElement | null;
      if (tblBtn && el.contains(tblBtn)) {
        const table = tblBtn.closest(".md-tblwrap")?.querySelector("table") as HTMLTableElement | null;
        if (!table) return;
        void copyTableElement(table).then((ok) => flashTableButton(tblBtn, ok));
        return;
      }
      // 外链：**一律 preventDefault**。WebView2 里没拦的 <a> 会导航整个 webview
      // —— 应用被目标页替换、没有地址栏和后退按钮，未保存的正文还留在内存里。
      // 所以「点了没反应」也远好过「导航走」。只有 http/https/mailto 交给系统浏览器，
      // 协议白名单在后端 open_url 里再卡一次（相对路径 .md / file: / 自定义协议一律不动）。
      const link = (e.target as HTMLElement).closest("a") as HTMLAnchorElement | null;
      if (link && el.contains(link)) {
        e.preventDefault();
        const url = normalizeExternalUrl(link.getAttribute("href"));
        if (url) void invoke("open_url", { url }).catch(() => { /* 后端拒绝：保持静默，页面不动 */ });
        return;
      }
      // 块级行号：点击闪烁高亮整个内容块，辅助浏览定位
      const blknum = (e.target as HTMLElement).closest(".md-blknum") as HTMLElement | null;
      if (blknum && el.contains(blknum)) {
        const block = blknum.parentElement;
        if (block) {
          block.classList.add("md-flash");
          setTimeout(() => block.classList.remove("md-flash"), 900);
        }
        return;
      }
      // mermaid「编辑」按钮：派发事件，由顶层监听打开流程图编辑器（闭环入口）
      const editBtn = (e.target as HTMLElement).closest(".md-mermaid-edit") as HTMLButtonElement | null;
      if (editBtn && el.contains(editBtn)) {
        const raw = editBtn.closest(".md-codeblock-mermaid")?.querySelector(".md-mermaid-raw code");
        const source = raw?.textContent ?? "";
        window.dispatchEvent(new CustomEvent("pp:mermaid-edit", { detail: { source } }));
        return;
      }
      // 正文图片：打开放大层。图片包在 <a> 里时由上面的链接分支接走
      // （可点击的图优先当链接，与 GitHub 一致），这里只处理「光板图」。
      const img = (e.target as HTMLElement).closest("img") as HTMLImageElement | null;
      if (img && el.contains(img)) {
        const src = img.currentSrc || img.src;
        if (src) setZoomed({ src, alt: img.alt || "" });
        return;
      }
      const btn = (e.target as HTMLElement).closest(".md-copybtn") as HTMLButtonElement | null;
      if (!btn || !el.contains(btn)) return;
      const pre = btn.closest(".md-codeblock")?.querySelector("pre");
      if (!pre) return;
      // 行号模式下逐行拼接 md-clc（排除行号列），否则沿用 innerText
      const lineEls = pre.querySelectorAll(".md-clc");
      const copyText =
        lineEls.length > 0
          ? Array.from(lineEls).map((l) => l.textContent ?? "").join("\n")
          : pre.innerText;
      // 复位成初始态（成功/失败共用）
      const restore = (ms: number) =>
        setTimeout(() => {
          btn.innerHTML = `${COPY_ICON} 复制`;
          btn.classList.remove("md-copied", "md-copyfail");
        }, ms);
      // 失败必须有反馈。旧实现注释写着"静默"，但成功有反馈、失败没反馈，
      // 两者在界面上的区别是"按钮变了"和"按钮没变"——而后者跟"点歪了没点着"
      // 长得一模一样：用户以为已经复制了，去粘贴时拿到的是上一次剪贴板的内容。
      const fail = () => {
        btn.textContent = "复制失败";
        btn.classList.add("md-copyfail");
        restore(1600);
      };
      // 剪贴板 API 整个不可用时（非安全上下文等）也要走失败分支，
      // 否则 ?. 短路后什么都不会发生，跟上面那个静默失败是同一个坑。
      const p = navigator.clipboard?.writeText(copyText);
      if (!p) {
        fail();
        return;
      }
      p.then(() => {
        btn.textContent = "✓ 已复制";
        btn.classList.add("md-copied");
        restore(1200);
      }).catch(fail);
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, [containerRef, setZoomed, toggleRef]);
}
