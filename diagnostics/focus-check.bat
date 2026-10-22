@echo off
chcp 65001 >nul
cd /d "%~dp0\.."
echo 正在启动焦点检测，请稍等...
node diagnostics\focus-steal-check.mjs
echo.
pause
