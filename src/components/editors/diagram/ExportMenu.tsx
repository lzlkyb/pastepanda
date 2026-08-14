/**
 * 导出下拉（PNG / SVG / Mermaid / .panda）——**内嵌编辑器与全屏编辑器共用这一份**（规则 #11）。
 *
 * 以前是纯 CSS 的 hover 下拉，两处各抄一遍 JSX，有三个毛病：
 *  1. 按钮与菜单中间有 4px 死区，鼠标移过去那一瞬间既不在按钮上也不在菜单上，
 *     hover 断掉 → display:none → 菜单一没就再也进不去（用户报的就是这个）；
 *  2. 「导出」按钮本身的单击直接导了 PNG——想开菜单却点了按钮就会凭空落一个文件；
 *  3. hover 菜单键盘没法操作。
 *
 * 改成受控的「点击展开」。关闭用 window 上的 pointerdown 而不是透明遮罩：
 * 画布里的 .popBackdrop 是 `absolute; inset:0` 挂在 .root 上、只盖得住画布，
 * 而本菜单在工具栏里，没有一个同等的“整块父容器”可铺；改拿 fixed 遮罩又会被
 * 工具栏自己的层叠上下文（FullscreenEditor 里 .toolbar 是 z-index:30）关进去，徒增不确定。
 */
import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import type { ExportKind } from "./useDiagramExport";
import styles from "../DiagramEditor.module.css";

const ITEMS: { kind: ExportKind; label: string }[] = [
  { kind: "png", label: "🖼 PNG 图片" },
  { kind: "svg", label: "📐 SVG 矢量" },
  { kind: "mermaid", label: "🧩 Mermaid 源码" },
  { kind: "panda", label: "💾 PastePanda 文件" },
];

export function ExportMenu({ onExport }: { onExport: (kind: ExportKind) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    // 点到菜单与触发按钮之外就关。
    // 用 pointerdown 而不是 click：click 要等抬手才发，期间菜单还站着，看上去慢半拍。
    // 不能用 onBlur：菜单里点完一项会弹系统保存对话框，焦点本来就会跑出去。
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    // Esc 关菜单，并把焦点送回触发按钮（否则焦点留在被卸载的菜单项上、掉回 body）。
    // 不调 stopPropagation：画布自己的 Esc（取消选中）还要能收到。
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      btnRef.current?.focus();
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={styles.exportWrap} ref={wrapRef}>
      <button
        ref={btnRef}
        className={styles.ghostBtn}
        aria-haspopup="menu"
        aria-expanded={open}
        title="导出为…"
        onClick={() => setOpen((v) => !v)}
      >
        <Download size={14} /> 导出
      </button>

      {open && (
        <div className={styles.exportMenu} role="menu">
          {ITEMS.map((it) => (
            <button
              key={it.kind}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onExport(it.kind);
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
