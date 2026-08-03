@echo off
setlocal
cd /d "%~dp0"
title AnyScope Windows OCR

echo AnyScope Windows native OCR helper
echo.
if "%~1"=="" (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0AnyScope-Windows-OCR.ps1"
) else (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0AnyScope-Windows-OCR.ps1" -LaunchUrl "%~1"
)
set "ANYSCOPE_EXIT=%ERRORLEVEL%"

echo.
if not "%ANYSCOPE_EXIT%"=="0" (
  echo The OCR helper did not finish. Review the message above and try again.
)
pause
exit /b %ANYSCOPE_EXIT%
