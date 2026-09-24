#!/usr/bin/env bash
# 实验：同一个 exe、同一时刻、同样 GPU 偏好下，MF MFT 路径 vs NVENC SDK 路径
# 目的：判定「去掉 MF 直连厂商 SDK」是否从原理上绕开 0x8000FFFF
FF="D:/AItool/winapp/pastePanda/probe/_ff/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe"
cd "D:/AItool/winapp/pastePanda/probe/_ff" || exit 1

echo "########## A: 同一 exe 内，MF 路径 vs NVENC 路径（都显式 nv12）##########"
echo
echo "--- A1: h264_mf 强制硬件（MediaFoundation 硬编 MFT 路径）---"
"$FF" -hide_banner -nostats -y -loop 1 -framerate 30 -i cap.png -t 2 \
   -pix_fmt nv12 -c:v h264_mf -hw_encoding 1 -f null - 2>&1 | tr '\r' '\n' \
   | grep -viE "^frame=|^$" | tail -14

echo
echo "--- A2: h264_mf 默认（可能是软编 MFT）---"
"$FF" -hide_banner -nostats -y -loop 1 -framerate 30 -i cap.png -t 2 \
   -pix_fmt nv12 -c:v h264_mf -f null - 2>&1 | tr '\r' '\n' \
   | grep -viE "^frame=|^$" | tail -8

echo
echo "--- A3: h264_nvenc（NVENC SDK 路径）---"
"$FF" -hide_banner -nostats -y -loop 1 -framerate 30 -i cap.png -t 2 \
   -pix_fmt nv12 -c:v h264_nvenc -benchmark -f null - 2>&1 | tr '\r' '\n' \
   | grep -viE "^frame=|^$" | tail -10

echo
echo "########## B: 动态内容（testsrc2，运动画面）—— libx264 vs NVENC ##########"
printf "  %-12s %-10s %-10s %8s %8s %7s\n" "源" "分辨率" "编码器" "fps" "ms/帧" "占核"
row() {
  local src="$1" res="$2" enc="$3" extra="$4"
  local out
  if [ "$src" = "testsrc2" ]; then
    out=$("$FF" -hide_banner -nostats -y -f lavfi -i "testsrc2=size=$res:rate=30:duration=3" \
      -pix_fmt yuv420p -c:v "$enc" $extra -benchmark -f null - 2>&1 | tr '\r' '\n')
  fi
  local ut st rt
  ut=$(printf '%s' "$out" | grep -o 'utime=[0-9.]*' | head -1 | cut -d= -f2)
  st=$(printf '%s' "$out" | grep -o 'stime=[0-9.]*' | head -1 | cut -d= -f2)
  rt=$(printf '%s' "$out" | grep -o 'rtime=[0-9.]*' | head -1 | cut -d= -f2)
  if [ -z "$rt" ]; then printf "  %-12s %-10s %-10s   !! FAILED\n" "$src" "$res" "$enc"; return; fi
  awk -v a="$src" -v b="$res" -v c="$enc" -v ut="$ut" -v st="$st" -v rt="$rt" 'BEGIN{
    n=90; s=ut+st; printf "  %-12s %-10s %-10s %8.1f %8.2f %7.2f\n", a,b,c, n/rt, rt*1000/n, s/rt }'
}
for res in 1920x1080 2560x1440; do
  for p in ultrafast veryfast; do
    row testsrc2 "$res" libx264 "-preset $p -tune zerolatency -g 30 -bf 0 -crf 23"
  done
  row testsrc2 "$res" h264_nvenc "-preset p4 -tune ll -g 30 -bf 0"
done
