#!/usr/bin/env bash
# libx264 / NVENC 编码速度对照（远控低延迟口径）
# 2026-09-24：回答「去掉 MF 全用 libx264 是否可行」
FF="D:/AItool/winapp/pastePanda/probe/_ff/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe"
cd "D:/AItool/winapp/pastePanda/probe/_ff" || exit 1

echo "===== ffmpeg 版本 ====="
"$FF" -hide_banner -version 2>&1 | head -1
echo "===== 可用编码器 ====="
"$FF" -hide_banner -encoders 2>/dev/null | grep -iE "libx264|264_nvenc|hevc_nvenc|264_qsv|h264_mf|264_amf"

echo
echo "===== libx264 编码速度 ====="
echo "口径 tune=zerolatency g=30 bf=0 crf=23  每档 3 秒 = 90 帧"
printf "%-9s %-11s %-10s %8s %9s %11s %8s\n" "图" "分辨率" "preset" "fps" "ms/帧" "CPU秒/帧" "占核"
bench() {
  local img="$1" vf="$2" preset="$3"
  local vfarg=()
  [ -n "$vf" ] && vfarg=(-vf "scale=$vf")
  local out
  out=$("$FF" -hide_banner -nostats -y -loop 1 -framerate 30 -i "$img" -t 3 \
        "${vfarg[@]}" -c:v libx264 -preset "$preset" -tune zerolatency \
        -g 30 -bf 0 -crf 23 -benchmark -f null - 2>&1 | tr '\r' '\n')
  local ut st rt
  ut=$(printf '%s' "$out" | grep -o 'utime=[0-9.]*' | head -1 | cut -d= -f2)
  st=$(printf '%s' "$out" | grep -o 'stime=[0-9.]*' | head -1 | cut -d= -f2)
  rt=$(printf '%s' "$out" | grep -o 'rtime=[0-9.]*' | head -1 | cut -d= -f2)
  if [ -z "$rt" ]; then printf "%-9s %-11s %-10s   !! FAILED\n" "$img" "${vf:-native}" "$preset"; return; fi
  awk -v a="$img" -v b="${vf:-native}" -v c="$preset" -v ut="$ut" -v st="$st" -v rt="$rt" 'BEGIN{
    n=90; s=ut+st;
    printf "%-9s %-11s %-10s %8.1f %9.2f %11.3f %8.2f\n", a,b,c, n/rt, rt*1000/n, s/n, s/rt }'
}

for img in cap.png rand.png; do
  for p in ultrafast superfast veryfast fast medium; do
    bench "$img" "" "$p"
    if [ "$img" = "cap.png" ]; then bench "$img" "2560x1440" "$p"; fi
  done
done

echo
echo "===== NVENC 直连（绕开 MF MFT，走 nvEncodeAPI64.dll）====="
echo "当前进程无 GPU 首选项（= 系统默认），看它是否受同一个 bug 影响"
for enc in h264_nvenc hevc_nvenc; do
  echo "--- $enc ---"
  "$FF" -hide_banner -nostats -y -loop 1 -framerate 30 -i cap.png -t 2 \
     -c:v "$enc" -benchmark -f null - 2>&1 | tr '\r' '\n' \
     | grep -vE "^frame=|^$|^size=" | tail -14
done
