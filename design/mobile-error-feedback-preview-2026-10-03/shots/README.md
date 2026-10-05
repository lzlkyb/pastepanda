截图配图目录（可选，非必填）

默认方案：发版说明 / 教练卡的「配图」由 Canvas 实时绘制（见 src/components/Illustration.tsx），
CHANGELOG 写的是插图 key（ocr / mosaic / eraser），**无需任何图片文件，也不会 404**。

只有在「想要真实质感截图」时才用到本目录：
  1. 打开 tools/shot-gen.html（纯浏览器，零依赖），点「全部下载」导出三张 PNG；
     或自行截一张真实效果图。
  2. 把文件放进 public/shots/，命名为 ocr.png / mosaic.png / eraser.png（或 .jpg）。
  3. 把 CHANGELOG 对应条目的「配图：ocr」改成图片路径形式「配图：shots/ocr.png」。
     App 检测到是路径就走 <img>，自动覆盖 Canvas 绘制版。

机制细节：
  - 媒体字段语义见 src/lib/changelog.ts：key（ocr/mosaic/eraser）= Canvas 绘制；
    含「/」或「.」的路径 = 真实图片，失败降级为 default 图。
  - Vite 把 public/ 原样拷到构建根，故从站点根以 /shots/xxx 引用。
