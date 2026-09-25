FFmpeg 裁剪构建（PastePanda 随包分发）
=====================================

版本：FFmpeg 9.0.2（libavcodec 63.1.102 / libavutil 61.x）
许可：LGPL-2.1-or-later（见同目录 LICENSE-FFmpeg-lgpl-2.1.txt）
配置：--disable-gpl（全部组件为 LGPL 授权，无 GPL 组件）
用途：视频硬编编码后端（h264/hevc × nvenc/qsv/amf 共 6 个编码器），仅编码段。

构建配置（configure 摘要）：
  --enable-shared --disable-static --disable-programs --disable-doc
  --disable-autodetect --disable-everything --disable-network
  --disable-avdevice --disable-avformat --disable-avfilter
  --disable-swscale --disable-swresample
  --enable-ffnvcodec --enable-nvenc --enable-libvpl --enable-amf
  --enable-parser=hevc
  --enable-d3d11va
  --enable-encoder=h264_nvenc,h264_qsv,h264_amf,hevc_nvenc,hevc_qsv,hevc_amf

  注：--enable-parser=hevc 是链接必需（hevc_qsv_encoder 的上游依赖声明缺
  hevc_sei，parse.o 引用的 ff_hevc_decode_nal_sei 在其中；不带它链接失败）。
  注：--enable-d3d11va 打开 D3D11 hwcontext（--disable-everything 会连它一起
  关掉）。当前编码链未用 hwaccel，仅保留扩展能力（avcodec +19 KB）。

源码获取（LGPL 第 4 条义务）：
  上游完整源码：https://ffmpeg.org/download.html（ffmpeg-9.0.2.tar.xz）
  本应用的裁剪构建脚本：仓库 probe/_ff/ 与
  docs/远程电脑-硬件编码方案-调研与决策-2026-09-24.md §3.8.7
  （configure 原样记录，可逐字复现本目录 DLL）。

替换义务（LGPL 第 6 条）：
  本目录 DLL 为动态链接。你可以用自行编译的同名 DLL 替换本目录文件
  （保持文件名与导出符号一致即可），应用加载逻辑支持任意位置的
  avcodec-63.dll / avutil-61.dll。

文件清单：
  avcodec-63.dll / avutil-61.dll   FFmpeg 裁剪构建产物（strip 后）
  libvpl-2.dll                     Intel oneVPL 运行时（MSYS2 mingw-w64-x86_64-libvpl）
  libstdc++-6.dll / libgcc_s_seh-1.dll / libwinpthread-1.dll
                                   MinGW-w64 GCC 运行时（libvpl-2.dll 的依赖）
