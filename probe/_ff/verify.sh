#!/usr/bin/env bash
FF="D:/AItool/winapp/pastePanda/probe/_ff/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe"
cd "D:/AItool/winapp/pastePanda/probe/_ff" || exit 1

NS=""
for p in /c/Windows/System32/nvidia-smi.exe "/c/Program Files/NVIDIA Corporation/NVSMI/nvidia-smi.exe"; do
  [ -f "$p" ] && NS="$p" && break
done
echo "nvidia-smi: ${NS:-未找到}"
[ -n "$NS" ] && "$NS" --query-gpu=name,driver_version --format=csv,noheader

echo
echo "=== 1. h264_mf 强制硬件：它到底选了哪台 MFT ==="
"$FF" -hide_banner -loglevel verbose -y -loop 1 -framerate 30 -i cap.png -t 1 \
  -pix_fmt nv12 -c:v h264_mf -hw_encoding 1 -f null - 2>&1 \
  | grep -iE "mft|hardware|vendor|device|fail|error|stream format" | head -20

echo
echo "=== 2. NVENC 真在硬件上吗（编码时抓 encoder 利用率）==="
if [ -n "$NS" ]; then
  echo "--- h264_nvenc 编码中 ---"
  "$FF" -hide_banner -nostats -y -f lavfi -i "testsrc2=size=1920x1080:rate=30:duration=8" \
     -pix_fmt yuv420p -c:v h264_nvenc -f null - >/dev/null 2>&1 &
  BG=$!
  sleep 3
  for i in 1 2 3; do "$NS" --query-gpu=utilization.gpu,utilization.encoder --format=csv,noheader; sleep 1; done
  wait $BG
  echo "--- libx264 编码中（对照，encoder 应为 0）---"
  "$FF" -hide_banner -nostats -y -f lavfi -i "testsrc2=size=1920x1080:rate=30:duration=6" \
     -pix_fmt yuv420p -c:v libx264 -preset veryfast -tune zerolatency -f null - >/dev/null 2>&1 &
  BG=$!
  sleep 3
  for i in 1 2 3; do "$NS" --query-gpu=utilization.gpu,utilization.encoder --format=csv,noheader; sleep 1; done
  wait $BG
else
  echo "跳过：找不到 nvidia-smi"
fi
