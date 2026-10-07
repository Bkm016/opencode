; 安装后把自带 CLI 所在目录（resources\cli）加到当前用户的 PATH，新开的终端里就能直接用 opencode。
; 用 PowerShell 读写注册表原始值并保持 REG_EXPAND_SZ，避免把 %USERPROFILE% 之类的变量展开写死。
; 目录通过环境变量传给 PowerShell，不用处理路径里的空格和引号转义。

!macro opencodeUpdatePath ACTION
  System::Call 'Kernel32::SetEnvironmentVariable(t "OPENCODE_CLI_DIR", t "$INSTDIR\resources\cli")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "OPENCODE_PATH_ACTION", t "${ACTION}")i'
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d = $$env:OPENCODE_CLI_DIR.TrimEnd('\'); $$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); $$p = [string]$$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames'); $$parts = @($$p -split ';' | Where-Object { $$_ -and $$_.TrimEnd('\') -ne $$d }); if ($$env:OPENCODE_PATH_ACTION -eq 'add') { $$parts += $$d }; $$k.SetValue('Path', ($$parts -join ';'), 'ExpandString'); $$k.Close()"`
  Pop $0
  ; 通知资源管理器等进程环境变量已变，之后新开的终端才能读到新的 PATH
  SendMessage 0xFFFF 0x1A 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro customInstall
  !insertmacro opencodeUpdatePath "add"
!macroend

!macro customUnInstall
  ; 自动更新时会先跑旧版卸载再装新版，这时不动 PATH
  ${ifNot} ${isUpdated}
    !insertmacro opencodeUpdatePath "remove"
  ${endIf}
!macroend
