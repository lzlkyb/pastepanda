#!/bin/bash
cd /d/AItool/winapp/pastePanda || exit 1
export LIBCLANG_PATH="$(pwd -W)/src-tauri/.libclang"
echo "LIBCLANG_PATH=$LIBCLANG_PATH"
# nohup 脱离父 shell，避免 Bash 工具在 ~13s 误杀 npm 父进程
nohup npm run tauri dev > /tmp/pastepanda-dev.log 2>&1 < /dev/null &
echo "bg_pid=$!"
sleep 1
echo "launched"
