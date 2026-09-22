# 模型连接失败与有限重试

2026-09-23，鹈鹕骑车长程任务的失败排查与修复记录。

## 根因

任务里的命令审批已经通过，工具也已执行完成；失败发生在下一次模型请求。独立 Node fetch 请求 OpenCode 的模型列表时，同样复现了约 5 秒后的 `ECONNRESET`，后续请求又成功，说明瞬时 TLS 建连失败与审批无关。

AI SDK 会将 Node 的 `TypeError: fetch failed` 解包为携带底层 cause 的 `APICallError`。Pico 在脱敏包装后保留了安全的 transportCode，但 Runtime 原来的分类没有利用该字段，导致本应可恢复的连接失败只尝试一次就结束任务。

## 修复边界

- 对 `request_failed`，仅在尚无 HTTP 状态、尚未观察到响应头时，识别六种安全传输码：`ECONNRESET`、`EAI_AGAIN`、`ETIMEDOUT`、`UND_ERR_CONNECT_TIMEOUT`、`UND_ERR_HEADERS_TIMEOUT`、`UND_ERR_SOCKET`。
- 保留现有每次逻辑调用最多 3 次总尝试和可取消退避；本次没有增加无限重试或外层重跑任务。
- 已执行工具和已经通过的审批不重放；仅重新发送尚未成功的模型请求。
- 取消、未知错误、无错误码的脱敏错误、永久性连接配置错误，以及已经收到响应的传输错误，不进入此次新增的传输恢复分支。
- 每次物理尝试仍独立记账，共享逻辑调用身份并递增 retryAttempt。错误原因原文、请求正文和凭证不进入诊断输出。

## 与参考实现的关系

| 实现                                                      | 普通尝试预算                | 退避与恢复边界                                                                                |
| --------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------- |
| Maka，固定提交 `5846521372d2dd0d3d2d33dc7784dd046dc3f7c8` | 每步最多 10 次总尝试        | 1 秒起、32 秒封顶，加抖动；支持 Retry-After；检查剩余步骤预算和可观察输出，特定流恢复另有限额 |
| Claude Code，官方文档                                     | 默认最多 10 次重试          | 指数退避；瞬时服务器、连接故障可恢复；流停滞等恢复有单独限额                                  |
| Pico，本次修复                                            | 每次逻辑调用最多 3 次总尝试 | 保留现有 300ms 起的带抖动退避，修复响应前传输错误漏分类；不声称已完全复刻另外两者的恢复状态机 |

Maka 对照源：`packages/runtime/src/provider-error-classification.ts`、`packages/runtime/src/ai-sdk-turn.ts`。Claude Code 参考：[自动重试](https://code.claude.com/docs/en/errors#automatic-retries)、[环境变量](https://code.claude.com/docs/en/env-vars)。以上次数明确区分“总尝试”和“重试”。

## 确定性验收

4 个 Provider 集成测试文件共 10 项通过，覆盖三个现有 Provider 的 SDK 主路径、错误脱敏、六种安全传输码恢复、3 次耗尽、取消与响应后错误不进入新增恢复分支，以及完整 AgentRuntime 中“审批一次 → 编辑一次 → 下一请求 TLS 失败 → 请求恢复”的持久化结果。

通过 `build:packages`、根目录 TypeScript 检查、架构检查、相关 ESLint/Prettier 与桌面打包。首次打包遭遇下载网络失败，第二次完成并通过打包产物校验。
