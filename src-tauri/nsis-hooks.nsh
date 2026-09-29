; PastePanda 安装器钩子，由 tauri.conf.json 的 bundle.windows.nsis.installerHooks 引用。
;
; Tauri 自带的「应用正在运行」检查走 Windows Restart Manager 的 RmShutdown：不杀子进程树、
; 不重试，一次失败就直接 Abort 安装，报 "Failed to kill PastePanda"。这里在它之前先把
; 整棵进程树收干净，让那道检查大概率看不到残留进程。

!macro PASTE_PANDA_KILL_PROCESS_TREE
  !define PP_KILL_UID ${__LINE__}
  DetailPrint "Closing ${PRODUCTNAME} process tree before continuing..."
  StrCpy $R8 0
  pp_kill_loop_${PP_KILL_UID}:
    nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM "${MAINBINARYNAME}.exe"'
    Pop $R9
    ; 0 = 确实结束了进程（可能还有同名实例），128 = 已查无此进程，其余 = 无法执行 taskkill
    StrCmp $R9 "0" 0 pp_kill_done_${PP_KILL_UID}
    Sleep 300
    IntOp $R8 $R8 + 1
    IntCmp $R8 8 pp_kill_done_${PP_KILL_UID} pp_kill_loop_${PP_KILL_UID} pp_kill_done_${PP_KILL_UID}
  pp_kill_done_${PP_KILL_UID}:
    Sleep 500
  !undef PP_KILL_UID
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro PASTE_PANDA_KILL_PROCESS_TREE
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro PASTE_PANDA_KILL_PROCESS_TREE
!macroend
