#!/usr/bin/env bash
# 条件：ffmpeg.exe 已被强制 GpuPreference=1（省电=核显）
FF="D:/AItool/winapp/pastePanda/probe/_ff/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe"
cd "D:/AItool/winapp/pastePanda/probe/_ff" || exit 1

echo "########## 条件：ffmpeg.exe 强制 GpuPreference=1（核显）##########"
echo
echo "--- B1: h264_mf 强制硬件（MF 路径）---"
"$FF" -hide_banner -loglevel verbose -y -loop 1 -framerate 30 -i cap.png -t 1 \
  -pix_fmt nv12 -c:v h264_mf -hw_encoding 1 -f null - >/tmp/b1.log 2>&1
echo "退出码=$?"
tr '\r' '\n' < /tmp/b1.log | grep -iE "friendly_name|activate mft|fail|error|0x8|mft name|stream format|not found|no mft" | head -12

echo
echo "--- B2: h264_nvenc（NVENC SDK 路径）---"
"$FF" -hide_banner -nostats -y -loop 1 -framerate 30 -i cap.png -t 2 \
  -pix_fmt nv12 -c:v h264_nvenc -benchmark -f null - >/tmp/b2.log 2>&1
echo "退出码=$?"
tr '\r' '\n' < /tmp/b2.log | grep -iE "error|fail|cannot|unable|no capable|missing|0x8|bench:|Video: h264" | head -10

echo
echo "--- B3: libx264（对照，应不受偏好影响）---"
"$FF" -hide_banner -nostats -y -loop 1 -framerate 30 -i cap.png -t 2 \
  -pix_fmt yuv420p -c:v libx264 -preset veryfast -tune zerolatency -benchmark -f null - >/tmp/b3.log 2>&1
echo "退出码=$?"
tr '\r' '\n' < /tmp/b3.log | grep -iE "bench:" | head -3
