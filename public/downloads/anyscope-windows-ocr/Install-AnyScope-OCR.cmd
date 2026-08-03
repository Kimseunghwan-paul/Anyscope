@echo off
setlocal
cd /d "%~dp0"
title AnyScope Windows OCR Setup
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-AnyScope-OCR.ps1"
set "ANYSCOPE_EXIT=%ERRORLEVEL%"
echo.
if "%ANYSCOPE_EXIT%"=="0" (
  echo Setup complete. You can now use the Windows OCR button in AnyScope.
) else (
  echo Setup did not finish. Review the message above and try again.
)
pause
exit /b %ANYSCOPE_EXIT%
