/**
 * OCR 选字模式胶囊：取代工具栏里的分段开关，锚定选区上缘右上角。
 *
 * 纯展示组件：不持有状态、不发 IPC。当前模式与切换逻辑都由父组件
 * （ScreenshotOverlay）持有——它走 get_config / save_config 与设置页同步。
 *
 * 为什么是胶囊而不是工具栏里的按钮：模式是会话级状态、不是标注工具，
 * 不该占主栏的黄金右位（规则 17.2）；而选区上缘通常是遮罩死区，
 * 锚在那里不压正在画的标注。深色卡片语言对齐 .mask-bar（自动打码确认条）。
 */

import type { OcrSelectMode } from "@/lib/screenshot/types";

interface Props {
  /** 供父组件实测胶囊宽高（右对齐选区右缘需要真实宽度，文本态会变宽） */
  innerRef?: React.Ref<HTMLDivElement>;
  /** 当前模式（唯一状态，父组件持有） */
  mode: OcrSelectMode;
  /** 点击切换。父组件在 smart / modifier 之间翻转并落盘 */
  onToggle: () => void;
  /** 位置（modePillPos 算好的 CSS 像素） */
  left: number;
  top: number;
}

export function ModePill({ innerRef, mode, onToggle, left, top }: Props) {
  const smart = mode === "smart";
  return (
    <div
      ref={innerRef}
      className="mode-pill"
      data-tip={
        smart
          ? "当前：智能意图 · 点击切换为 Ctrl 修饰键"
          : "当前：Ctrl 修饰键 · 点击切换为智能意图"
      }
      style={{ left, top }}
      // 不让事件冒泡到父容器（与 mask-bar 等悬浮元素同款；标注画布的事件在别的元素上）
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onToggle}
    >
      <span className={`dot${smart ? " smart" : " ctrl"}`} />
      {smart ? "智能意图" : "Ctrl"}
      <span className="sw">⇄</span>
    </div>
  );
}
