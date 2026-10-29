# Gỡ hẳn ClaudeDeck khi trình gỡ cài đặt bị kẹt.
# Chạy: chuột phải file này > "Run with PowerShell"
#   hoặc: powershell -ExecutionPolicy Bypass -File .\ClaudeDeck-Cleanup.ps1
# Thêm -RemoveData để xoá luôn dữ liệu app (%APPDATA%\ClaudeDeck: project, task, cài đặt).
param([switch]$RemoveData)

$ErrorActionPreference = "SilentlyContinue"
$keys = @(
  "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
  "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
  "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
)
$entries = @(Get-ItemProperty $keys | Where-Object { $_.DisplayName -like "ClaudeDeck*" })

# Thư mục cài đặt: lấy từ registry, thêm các vị trí mặc định.
$dirs = @("$env:LOCALAPPDATA\Programs\ClaudeDeck", "$env:ProgramFiles\ClaudeDeck")
foreach ($e in $entries) {
  if ($e.InstallLocation) { $dirs += $e.InstallLocation }
  if ($e.UninstallString) { $dirs += Split-Path ($e.UninstallString -replace '"', '' -replace ' /.*$', '') }
}
$dirs = $dirs | Where-Object { $_ } | Select-Object -Unique

Write-Host "1/4 Tắt ClaudeDeck và các tiến trình con..."
taskkill.exe /F /T /IM ClaudeDeck.exe 2>$null | Out-Null
foreach ($d in $dirs) {
  Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith("$d\", "CurrentCultureIgnoreCase") } |
    ForEach-Object { taskkill.exe /F /T /PID $_.ProcessId 2>$null | Out-Null }
}
Start-Sleep -Seconds 2

Write-Host "2/4 Chạy trình gỡ cài đặt..."
foreach ($d in $dirs) {
  $u = Join-Path $d "Uninstall ClaudeDeck.exe"
  if (Test-Path $u) { Start-Process -FilePath $u -ArgumentList "/S" -Wait }
}
Start-Sleep -Seconds 2

Write-Host "3/4 Xoá file còn sót..."
foreach ($d in $dirs) {
  if (Test-Path $d) { Remove-Item -LiteralPath $d -Recurse -Force }
  if (Test-Path $d) { Write-Host "   Chưa xoá được $d (file đang bị dùng). Khởi động lại máy rồi chạy lại script." -ForegroundColor Yellow }
}
Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\ClaudeDeck.lnk" -Force
Remove-Item "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\ClaudeDeck.lnk" -Force
Remove-Item "$([Environment]::GetFolderPath('Desktop'))\ClaudeDeck.lnk" -Force
Remove-Item "$env:PUBLIC\Desktop\ClaudeDeck.lnk" -Force

Write-Host "4/4 Xoá mục ClaudeDeck trong Settings > Apps..."
foreach ($e in $entries) { Remove-Item -LiteralPath $e.PSPath -Recurse -Force }

if ($RemoveData) {
  Remove-Item "$env:APPDATA\ClaudeDeck" -Recurse -Force
  Write-Host "Đã xoá dữ liệu app."
}
Write-Host "Xong." -ForegroundColor Green
