@echo off
chcp 65001 >nul
title pico-harness ACP (IDE 桥接)
echo.
echo  ==============================
echo   pico-harness ACP 协议模式
echo  ==============================
echo.
echo  启动 stdio JSON-RPC server,供 IDE(VSCode 插件等)驱动 Agent。
echo  此模式不直接交互,由 IDE 客户端通过 stdin/stdout 发送协议消息。
echo.
echo  运行模式(可选): default / plan / auto / yolo
echo    default = 人工审批写操作
echo    plan    = Plan Mode(只规划不执行)
echo    auto    = 自动放行(跳过审批)
echo    yolo    = 完全自动(无任何拦截)
echo.
npx tsx --env-file=.env src/cli/main.ts --acp --mode default
pause
