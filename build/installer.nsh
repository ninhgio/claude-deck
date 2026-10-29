; Thay bước kiểm tra "app đang chạy" mặc định của electron-builder (cài đặt và gỡ cài đặt):
; tự tắt hẳn ClaudeDeck cùng mọi tiến trình chạy từ thư mục cài đặt (terminal/OpenConsole,
; tiến trình con còn sót), thay vì hỏi rồi kẹt ở "ClaudeDeck cannot be closed".
!macro customCheckAppRunning
  DetailPrint "Đang đóng ${PRODUCT_NAME}…"
  nsExec::Exec `"$SYSDIR\taskkill.exe" /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  StrCpy $R1 0
  ${Do}
    IntOp $R1 $R1 + 1
    ; exit 0: vừa tắt thêm tiến trình → chờ rồi kiểm tra lại; exit 1: không còn gì.
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -C "$$p = @(Get-CimInstance Win32_Process | ? { $$_.ExecutablePath -and $$_.Name -notlike 'Uninstall*' -and $$_.ExecutablePath.StartsWith('$INSTDIR\', 'CurrentCultureIgnoreCase') }); foreach ($$x in $$p) { taskkill.exe /F /T /PID $$x.ProcessId | Out-Null }; if ($$p.Count -gt 0) { exit 0 } else { exit 1 }"`
    Pop $0
    ${If} $0 != 0
      ${ExitDo}
    ${EndIf}
    Sleep 1000
  ${LoopUntil} $R1 >= 5
!macroend
