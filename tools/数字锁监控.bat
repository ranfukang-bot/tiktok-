@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动数字锁监控（只读取状态，不会按键、不改设置）...
echo 保持这个窗口开着。要停就直接关掉窗口。
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0numlock-watch.ps1"
pause
