/**
 * 截图标注的共享类型。
 *
 * 从 ScreenshotOverlay 抽出来，因为几个纯函数模块（geometry / stitch / ocrTable）
 * 都要用到它们，而那些函数必须可单独导入才能写测试。
 */

/** 截屏结果：底图 data URL + 虚拟屏幕物理坐标与尺寸 */
export interface ScreenInfo {
  dataUrl: string;
  originX: number;
  originY: number;
  width: number;
  height: number;
}

/** 后端 snap_window_at 返回的窗口吸附矩形（物理像素，**屏幕坐标**） */
export interface SnapRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 选区 / 标注包围盒（物理像素，**底图局部坐标**） */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ToolId =
  | "rect"
  | "ellipse"
  | "arrow"
  | "pen"
  | "highlight"
  | "mosaic"
  | "blur"
  | "text"
  | "number"
  | "eraser"
  | "picker";

export interface Annotation {
  id: number;
  type: ToolId;
  color: string;
  width: number;
  x: number;
  y: number;
  x2: number;
  y2: number;
  points?: [number, number][];
  text?: string;
  size?: number;
  /** 箭头样式：single 单箭头 / double 双箭头 */
  arrowStyle?: "single" | "double";
  /** 马赛克色块 / 模糊半径（滚轮调节强度） */
  strength?: number;
}
