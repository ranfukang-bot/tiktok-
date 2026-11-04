#!/bin/bash
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "没有检测到 Node.js，请先去 https://nodejs.org 下载安装 LTS 版本，装完重新双击这个文件。"
  read -p "按回车关闭…"
  exit 1
fi

# 先读完整个代码块，再执行可能替换本启动脚本的更新器。
{
  node tools/self-update.mjs || { read -p "按回车关闭…"; exit 1; }
  echo "正在启动控制台，稍后会自动打开浏览器网页..."
  npm start
  exit $?
}
