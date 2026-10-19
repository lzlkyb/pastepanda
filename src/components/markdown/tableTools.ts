/**
 * 预览里的表格装饰（右上角「复制表格」）与复制动作。
 *
 * 为什么是后处理 DOM 注入而不是 marked 的 renderer：表格的 HTML 由 marked 生成，
 * 但按钮要复用**同一套**点击委托与状态反馈；而 renderer 返回的字符串无法引用
 * CSS Modules 的哈希类名（与代码块 md-code* 同一取舍）。
 *
 * 为什么要包一层 wrapper：`<table>` 自身是 `display:block; overflow-x:auto` 的横滚容器，
 * 按钮若放进表格内部会跟着横滚跑掉；wrapper 才是稳定的定位祖先。
 *
 * 🔴 红线：无 AI。纯 DOM 与剪贴板 IO。
 */
import { tableToRichHtml, tableToTsv } from "@/lib/markdown/tableCopy";

const WRAP_CLASS = "md-tblwrap";
const BTN_CLASS = "md-tblcopy";

/**
 * 给容器里每张表包 wrapper 并挂复制按钮。**幂等**：已包过的跳过，
 * 所以在 html 变化的 effect 里每次都调也安全。
 */
export function decorateTables(container: HTMLElement): void {
  container.querySelectorAll<HTMLTableElement>("table").forEach((table) => {
    if (table.closest(`.${WRAP_CLASS}`)) return;
    const wrap = document.createElement("div");
    wrap.className = WRAP_CLASS;

    table.parentNode?.insertBefore(wrap, table);
    wrap.appendChild(table);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = BTN_CLASS;
    btn.textContent = "复制表格";
    btn.title = "复制为表格（贴 Excel 得单元格，贴 Word / 邮件得排版）";
    wrap.appendChild(btn);
  });
}

/**
 * 复制表格到剪贴板，**同时**写 text/html 与 text/plain。
 * - 贴进 Excel / Sheets：拿到的是真单元格（TSV）；
 * - 贴进 Word / 邮件 / 飞书：拿到的是带边框和表头的表格（HTML）。
 * 环境不支持多 MIME（部分 WebView / 非安全上下文）时退到纯 TSV。
 *
 * @returns false 表示完全没写成功 —— 调用方必须给出可见反馈，
 *          不能像旧版代码块复制那样「静默成功」（用户会以为复制到了）。
 */
export async function copyTableElement(table: HTMLTableElement): Promise<boolean> {
  const tsv = tableToTsv(table);
  if (!tsv) return false;

  const clipboard = navigator.clipboard;
  if (!clipboard) return false;

  if (typeof ClipboardItem !== "undefined" && typeof clipboard.write === "function") {
    try {
      await clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([tableToRichHtml(table)], { type: "text/html" }),
          "text/plain": new Blob([tsv], { type: "text/plain" }),
        }),
      ]);
      return true;
    } catch {
      /* 某些环境拒绝写 text/html，退到纯文本 */
    }
  }

  if (typeof clipboard.writeText !== "function") return false;
  try {
    await clipboard.writeText(tsv);
    return true;
  } catch {
    return false;
  }
}

/** 按钮上的成功/失败反馈，复位为初始文案 */
export function flashTableButton(btn: HTMLButtonElement, ok: boolean): void {
  const reset = () => {
    btn.textContent = "复制表格";
    btn.classList.remove("md-tblcopy-ok", "md-tblcopy-fail");
  };
  btn.textContent = ok ? "已复制" : "复制失败";
  btn.classList.add(ok ? "md-tblcopy-ok" : "md-tblcopy-fail");
  window.setTimeout(reset, ok ? 1200 : 1600);
}
