Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$sourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$installRoot = Join-Path $env:LOCALAPPDATA "AnyScope\WindowsOCR"
$protocolRoot = "HKCU:\Software\Classes\anyscope-ocr"

try {
  New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $sourceRoot "AnyScope-Windows-OCR.ps1") -Destination $installRoot -Force
  Copy-Item -LiteralPath (Join-Path $sourceRoot "Run-AnyScope-OCR.cmd") -Destination $installRoot -Force

  New-Item -Path $protocolRoot -Force | Out-Null
  Set-ItemProperty -Path $protocolRoot -Name "(default)" -Value "URL:AnyScope Windows OCR"
  Set-ItemProperty -Path $protocolRoot -Name "URL Protocol" -Value ""
  $commandKey = New-Item -Path (Join-Path $protocolRoot "shell\open\command") -Force
  $launcher = Join-Path $installRoot "Run-AnyScope-OCR.cmd"
  Set-ItemProperty -Path $commandKey.PSPath -Name "(default)" -Value ('cmd.exe /c ""{0}" "%1""' -f $launcher)

  Write-Host ""
  Write-Host "AnyScope Windows OCR 연결이 완료되었습니다." -ForegroundColor Green
  Write-Host "이제 AnyScope 문서 관리에서 해당 문서의 'Windows OCR' 버튼만 누르면 됩니다."
  exit 0
} catch {
  Write-Host ""
  Write-Host ("설치하지 못했습니다: " + $_.Exception.Message) -ForegroundColor Red
  exit 1
}
