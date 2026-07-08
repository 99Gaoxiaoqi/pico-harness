@echo off
chcp 65001 >nul
title pico-harness TUI (静默日志)
echo.
echo  ==============================
echo   pico-harness TUI (静默日志)
echo  ==============================
echo   LOG_LEVEL=warn 只显示警告/错误,画面最干净
echo.
set LOG_LEVEL=error
npx tsx --import ./src/tui/preload-env.ts --env-file=.env src/cli/main.ts --tui
pause
