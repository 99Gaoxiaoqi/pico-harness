@echo off
chcp 65001 >nul
title pico-harness TUI
echo.
echo  ==============================
echo   pico-harness TUI 启动中...
echo  ==============================
echo.
echo  使用方式:
echo    直接打字输入消息, Enter 发送
echo    Alt+Enter 换行(多行输入)
echo    上下箭头翻输入历史
echo    按 e 展开工具结果
echo    Ctrl+C 退出
echo.
echo  想要安静日志: 用 LOG_LEVEL=warn 启动(见 启动TUI-安静模式.bat)
echo  想要默认 CLI: 用 启动CLI.bat
echo.
npx tsx --import ./src/tui/preload-env.ts --env-file=.env src/cli/main.ts --tui
pause
