@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 没有检测到 Node.js，请先去 https://nodejs.org 下载安装"LTS"版本（一路下一步就行），装完重新双击这个文件。
  pause
  exit /b 1
)

rem Parse the whole block before the updater can replace this batch file.
(
  node tools/self-update.mjs
  if errorlevel 1 (
    pause
    exit /b 1
  )

  echo 正在启动控制台，稍后会自动打开浏览器网页...
  call npm start
  if errorlevel 1 (
    pause
    exit /b 1
  )
  pause
  exit /b 0
)
