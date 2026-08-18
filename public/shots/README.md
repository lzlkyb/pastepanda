截图配图目录（发版前需放入真实截图）：
  ocr.jpg      —— 标注工具栏「取文字」按钮 + 识别后文字展开
  mosaic.jpg   —— 马赛克/模糊涂抹效果
  eraser.jpg   —— 橡皮擦分段擦除效果

路径约定：CHANGELOG 的「配图：」与截图工具栏 NEW 提示都用 /shots/xxx.jpg
（Vite 把 public/ 原样拷到构建根，故从站点根以 /shots/ 引用）。
缺图时弹框/教练卡会优雅降级为「配图占位」框，不会报错。
