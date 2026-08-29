@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 没有检测到 Node.js，请先去 https://nodejs.org 下载安装"LTS"版本（一路下一步就行），装完重新双击这个文件。
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo 第一次运行，正在安装依赖，请稍等（只需要一次，之后启动会很快）...
  call npm install
  if errorlevel 1 (
    echo 依赖安装失败，请把上面的错误信息截图给开发者。
    pause
    exit /b 1
  )
)

echo 正在启动控制台，稍后会自动打开浏览器网页...
call npm start

pause
