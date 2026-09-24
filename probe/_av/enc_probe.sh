#!/usr/bin/env bash
# FFmpeg 硬件编码器「能否真出首包」逐路探针
# 用法: enc_probe.sh <条件标签>
# 说明: 每路真实编码 2 秒 1080p NV12，以退出码 + 输出字节数判定，
#       不看任何"支持列表"这类静态信息（avcodec 的 hw_configs 只是声明）。
BIN="D:/AItool/winapp/pastePanda/probe/_av/ffmpeg-master-latest-win64-lgpl-shared/bin"
FF="$BIN/ffmpeg.exe"
LABEL="${1:-baseline}"

echo "########## 条件：$LABEL ##########"
echo "--- 注册表 ffmpeg 条目 ---"
reg query "HKCU\Software\Microsoft\DirectX\UserGpuPreferences" 2>&1 | grep -i ffmpeg || echo "(无 ffmpeg 条目)"
echo "--- 注册表 pick 条目 ---"
reg query "HKCU\Software\Microsoft\DirectX\UserGpuPreferences" 2>&1 | grep -i pick || echo "(无 pick 条目)"

run() {  # $1=编码器 $2=额外参数 $3=像素格式
  echo
  echo "--- $1 ---"
  "$FF" -hide_banner -nostats -f lavfi -i testsrc=size=1920x1080:rate=30 -t 2 \
    -pix_fmt "$3" -c:v "$1" $2 -benchmark -f null - >"/tmp/e_$1.log" 2>&1
  local rc=$?
  echo "退出码=$rc"
  tr '\r' '\n' < "/tmp/e_$1.log" | grep -iE "bench:|error|fail|cannot|unable|no capable|missing|0x8|not found|Video: h264" | head -6
}

run h264_nvenc ""                     nv12
run h264_qsv   ""                     nv12
run h264_amf   ""                     nv12
run h264_mf    "-hw_encoding 1"       nv12
echo
echo "########## 条件结束：$LABEL ##########"
