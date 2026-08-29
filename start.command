#!/bin/bash
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "没有检测到 Node.js，请先去 https://nodejs.org 下载安装 LTS 版本，装完重新双击这个文件。"
  read -p "按回车关闭…"
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "第一次运行，正在安装依赖，请稍等（只需要一次）..."
  npm install || { echo "依赖安装失败"; read -p "按回车关闭…"; exit 1; }
fi

echo "正在启动控制台，稍后会自动打开浏览器网页..."
npm start
