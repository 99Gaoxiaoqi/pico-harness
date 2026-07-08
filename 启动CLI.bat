@echo off
chcp 65001 >nul
title pico-harness CLI (默认单次执行)
echo.
echo  ==============================
echo   pico-harness CLI (单次模式)
echo  ==============================
echo.
echo  用法: 直接加你的 prompt, 例如:
echo    启动CLI.bat 你好,介绍一下这个项目
echo.
echo  或者进入交互 TUI:
echo    启动TUI.bat
echo.
if "%~1"=="" (
  echo [提示] 未提供 prompt, 将使用默认测试任务(读 README 并总结)
  echo.
  npx tsx --env-file=.env src/cli/main.ts
) else (
  npx tsx --env-file=.env src/cli/main.ts --prompt "%*"
)
pause
