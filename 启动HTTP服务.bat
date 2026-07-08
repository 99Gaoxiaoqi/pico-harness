@echo off
chcp 65001 >nul
title pico-harness HTTP+WS Server
echo.
echo  ==============================
echo   pico-harness HTTP+WS 服务模式
echo  ==============================
echo.
echo  启动后可用 REST API + WebSocket 流式推送:
echo    REST:  POST /sessions, GET /sessions/:id
echo           POST /sessions/:id/messages
echo           POST /approvals/:taskId, GET /tools
echo    WS:    ws://localhost:3000/?sessionId=^<id^>
echo.
echo  浏览器/Postman/curl 均可调用。
echo  按 Ctrl+C 停止服务。
echo.
npx tsx --env-file=.env src/cli/main.ts --serve --port 3000
pause
