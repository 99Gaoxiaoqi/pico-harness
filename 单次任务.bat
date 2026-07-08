@echo off
chcp 65001 >nul
title pico-harness 单次任务
echo.
echo  ==============================
echo   pico-harness 单次执行模式
echo  ==============================
echo.
echo  执行一次任务后退出(非交互)。
echo  把你的任务作为参数传入:
echo.
echo  示例:
echo    单次任务.bat 读一下 README.md 并总结
echo    单次任务.bat 找出所有 TODO 注释
echo.
echo  可选参数:
echo    --plan        Plan Mode(先规划再执行)
echo    --trace       记录决策树到 .claw/traces/
echo    --dir ./xxx   指定工作目录
echo.
set /p task="请输入任务: "
if "%task%"=="" (
  echo 未输入任务,使用默认: 读 README 并总结
  npx tsx --env-file=.env src/cli/main.ts --prompt "读一下 README.md 并用一句话总结这个项目"
) else (
  npx tsx --env-file=.env src/cli/main.ts --prompt "%task%"
)
pause
