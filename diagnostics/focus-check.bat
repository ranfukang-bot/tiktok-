@echo off
rem Keep this file ASCII-only with CRLF line endings. On Chinese Windows (GBK code page)
rem "chcp 65001" plus UTF-8 text makes cmd misread lines (it skipped "cd" and mangled text).
rem The Node script prints its own Chinese messages and finds the project by its own path.
echo Starting focus check, please wait...
node "%~dp0focus-steal-check.mjs"
echo.
pause
