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

/** 后端 snap_window_at 返回的双层吸附目标（屏幕坐标，物理像素）。
 *  - `win`：光标下最顶层窗口的视觉边界；
 *  - `ctrl`：命中的具体控件（真正要框选的区域）；无更细控件时回退到 `win`。
 *  前端 `toLocalRect` 把它俩各自转成底图局部坐标（Rect）。 */
export interface SnapTargets {
  win: SnapRect;
  ctrl: SnapRect;
}

/** 后端 enum_controls 返回的窗口控件清单（屏幕坐标，物理像素）。
 *  - `win`：窗口视觉边界；
 *  - `ctrls`：窗口内各逻辑控件边界（已过滤掉包裹更小控件的容器）。
 *  前端 `toLocalRect` 分别转成底图局部坐标（Rect）供键盘遍历。 */
export interface ControlList {
  win: SnapRect;
  ctrls: SnapRect[];
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
  | "picker"
  /** 一键自动打码（动作型，不是绘制工具）：点击即对图中隐私文本批量打码，不会进入绘制态 */
  | "automask"
  /** 去水印（路线 A 前端轻量 inpaint）。
   *  - 平铺模式：动行型，点击画布即对整屏平铺水印自动检测周期并批量重建（企业微信/钉钉/飞书同款）；
   *  - 手动模式：绘制型，拖拽涂抹/矩形选区，松开即局部 inpaint（单块 logo / 不规则水印）。
   *  strength 复用为边缘羽化半径（避免硬边接缝），shape 复用为 rect/brush。 */
  | "dewarp";

/** OCR 选字模式（标注态：标注与文字识别共存，零步互不抢事件）。
 *  - smart：落在文字上拖=选字；拖到文字区外自动转画标注（默认，最直觉）。
 *  - modifier：Ctrl/⌘ + 落文字内拖=选字；裸拖一律画标注（手势更明确，不误触）。 */
export type OcrSelectMode = "smart" | "modifier";

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
  /**
   * 遮罩类工具（马赛克 / 模糊 / 高亮）的形状。
   *
   * - `"rect"`：拖矩形（旧行为）
   * - `"brush"`：涂抹，路径存在 `points` 里。
   *   ❗ 笔宽**不是** `width` —— 要过 `maskBrushWidth(a)`（= width × 8）。
   *   `width` 那个 2/3/5 的档位是给描边定的，当涂抹笔刷细到没法用。
   *
   * ❗ **缺省必须当成 `"rect"`**：旧的标注没有这个字段，当成 brush 会因为
   * 没有 points 而什么都不画——已存的标注会默默消失。
   */
  shape?: "rect" | "brush";
  /**
   * 去水印·平铺模式标记：true 表示整屏平铺水印（一次性覆盖整选区，而非手动局部）。
   * 渲染时走「频域减回」（2D FFT 提取周期层 → 逐像素减回），天然处理斜排、不误伤背景。
   * 平铺周期由算法内部 FFT 自适应提取，不依赖外部预估值。
   */
  tiled?: boolean;
}
