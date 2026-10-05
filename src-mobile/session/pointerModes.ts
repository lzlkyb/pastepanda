export type PointerMode = "trackpad" | "direct" | "pad" | "floating";

export const POINTER_MODES: Record<PointerMode, { label: string; description: string; hint: string }> = {
  trackpad: { label: "触控板", description: "划动移动，点按点击指针处", hint: "触控板 · 划动移动指针" },
  direct: { label: "直接点击", description: "点哪里，操作哪里", hint: "直接点击 · 点击目标位置" },
  pad: { label: "独立触控板", description: "上方看画面，下方移动指针", hint: "独立触控板 · 下方划动移动指针" },
  floating: { label: "浮动鼠标", description: "拖动控制柄，指针在手指上方", hint: "浮动鼠标 · 拖动控制柄定位" },
};
