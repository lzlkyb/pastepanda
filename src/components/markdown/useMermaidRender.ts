import { useEffect, type RefObject } from "react";
import { listen } from "@tauri-apps/api/event";
import { mapMermaidTheme } from "@/lib/mermaidBlock";
import { currentTheme } from "@/lib/markdown/renderHtml";

/**
 * mermaid 流程图渲染（仅当页面含 mermaid 块才懒加载 mermaid 库）。
 * 监听 theme-changed 事件重渲染，切主题不掉队。
 */
export function useMermaidRender(
  containerRef: RefObject<HTMLDivElement | null>,
  html: string,
  clamp: boolean,
): void {
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const blocks = el.querySelectorAll<HTMLElement>(".md-codeblock-mermaid");
    if (blocks.length === 0) return;
    // 裁切场景（hover 弹窗）空间有限：展示源码而非渲染 SVG。
    // 看 clamp 而不是 compact——「字小」不是不渲染图的理由，「只有 120px」才是
    if (clamp) {
      blocks.forEach((b) => {
        const raw = b.querySelector<HTMLElement>(".md-mermaid-raw");
        if (raw) raw.style.display = "";
      });
      return;
    }
    let cancelled = false;
    let mermaidMod: typeof import("mermaid") | null = null;
    const renderAll = (theme: string) => {
      if (!mermaidMod) return;
      const mermaid = mermaidMod.default;
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: mapMermaidTheme(theme) });
      let seq = 0;
      blocks.forEach((b) => {
        const body = b.querySelector<HTMLElement>(".md-mermaid-body");
        const raw = b.querySelector<HTMLElement>(".md-mermaid-raw code");
        if (!body || !raw) return;
        const src = raw.textContent ?? "";
        const id = `mermaid-${Date.now()}-${seq++}`;
        mermaid
          .render(id, src)
          .then(({ svg }) => {
            if (cancelled) return;
            body.innerHTML = svg;
            b.classList.remove("md-mermaid-error");
            // 渲染成功后撤掉失败提示（重试/主题切换会重新 renderAll）
            b.querySelector<HTMLElement>(".md-mermaid-fail-note")?.remove();
          })
          .catch(() => {
            if (cancelled) return;
            b.classList.add("md-mermaid-error");
            // 守护-1（U3.5）：失败不能只显示裸源码——持久告知发生了什么。
            // 源码块已在 md-mermaid-error 下显示，其余内容不受影响。
            if (!b.querySelector(".md-mermaid-fail-note")) {
              const note = document.createElement("div");
              note.className = "md-mermaid-fail-note";
              note.textContent = "此图表语法无法渲染，已改显源码；文档其余部分不受影响。";
              b.prepend(note);
            }
            const pre = b.querySelector<HTMLElement>(".md-mermaid-raw");
            if (pre) pre.style.display = "";
            body.style.display = "none";
          });
      });
    };
    import("mermaid")
      .then((m) => {
        if (cancelled) return;
        mermaidMod = m;
        renderAll(currentTheme());
      })
      .catch(() => { /* mermaid 加载失败时保持源码块（已隐藏），不影响其余内容 */ });
    const unsubPromise = listen<{ theme?: string }>("theme-changed", () => {
      if (cancelled || !mermaidMod) return;
      renderAll(currentTheme());
    });
    return () => {
      cancelled = true;
      unsubPromise.then((u) => u());
    };
  }, [containerRef, html, clamp]);
}
