# 超时候选收敛：27 处手写超时原语统一

> 状态：**待实施**（方案已定稿，由新 session 执行）
> 建立日期：2026-08-13
> 关联：`docs/architecture/20-architecture-audit-and-governance.md` §3.2（横切唯一性原则）、`src/util/race-with-deadline.ts`（已有原语）、`scripts/check-architecture-boundaries.mjs` 白名单（31 条目）
> 约束：每个候选先读语义再改；**不改变行为语义**（超时值、错误类型、副作用保留）；每批独立提交 + 验证；收敛一处删一处白名单条目（保留理由注释到 commit body）

## 0. 一句话

横切唯一性原则：超时/延迟/排空这类横切原语，全仓只允许一个权威实现。当前 `src/util/race-with-deadline.ts` 已收敛 12 处（阶段 1 完成），但白名单里还有 **27 个既有手写原语**（1 canonical + 3 误报 + 27 候选，实际收敛目标 27 处）待统一。本轮把 27 处分类、分批收敛到 2-3 个原语，白名单从 31 降到 4（canonical + 3 误报）。

## 1. 候选清单与分类（来自白名单，2026-08-13 核验）

### A 族：sleep/delay helper（纯延迟，resolve 语义）—— 8 处

| 位置                                            | 现状                                              | 收敛目标                                            |
| ----------------------------------------------- | ------------------------------------------------- | --------------------------------------------------- |
| `src/input/user-config-store.ts`                | `delay()` helper                                  | `sleep(ms)`                                         |
| `src/mcp/user-config-store.ts`                  | `delay()` helper                                  | `sleep(ms)`                                         |
| `src/provider/provider-operation-journal.ts`    | `delay()` helper                                  | `sleep(ms)`                                         |
| `src/provider/retry.ts`                         | `sleep`/`abortableSleep`（clearTimeout 范式源头） | `sleep(ms, { signal? })`（abortableSleep 语义并入） |
| `src/runtime/agent-recoverable-task-adapter.ts` | `delay()` helper                                  | `sleep(ms)`                                         |
| `src/storage/atomic-json.ts`                    | `sleep()` helper                                  | `sleep(ms)`                                         |
| `src/input/cron-daemon-bridge.ts`               | daemon 启动重试退避 sleep                         | `sleep(ms)`                                         |
| `src/internal/headless-one-shot-runner.ts`      | `delay()` helper                                  | `sleep(ms)`                                         |

### B 族：请求/握手超时包装（reject 语义）—— 15 处

| 位置                                   | 现状                                          | 收敛目标                                                                                   |
| -------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `src/approval/manager.ts`              | 审批等待超时（executor 内 setTimeout reject） | `raceWithDeadlineReject`（errorFactory 产出原错误类型）                                    |
| `src/code-intelligence/lsp-client.ts`  | LSP 请求超时 / SIGKILL 升级（2 处）           | `raceWithDeadlineReject`                                                                   |
| `src/daemon/client.ts`                 | `connectWithTimeout`（socket 事件式）         | **评估后定**：socket 事件驱动结构特殊，若无法简单并入则保留 + 白名单注明（见 §4 保留清单） |
| `src/daemon/instance-lock.ts`          | runtime.ping 超时包装                         | `raceWithDeadlineReject`                                                                   |
| `src/daemon/ipc-auth.ts`               | Windows 工具执行超时                          | `raceWithDeadlineReject`                                                                   |
| `src/hooks/executors/executor.ts`      | SIGKILL 升级超时                              | `raceWithDeadlineReject`（保留 SIGKILL 副作用）                                            |
| `src/mcp/http-client.ts`               | 请求超时包装                                  | `raceWithDeadlineReject`（保留 sseAbort 副作用）                                           |
| `src/mcp/stdio-client.ts`              | 请求超时 / waitForChildExit（多处）           | `raceWithDeadlineReject`                                                                   |
| `src/os/process-tree.ts`               | waitForExit 超时包装                          | `raceWithDeadlineReject`                                                                   |
| `src/safety/background-yolo-policy.ts` | hook 超时 fail-closed                         | `raceWithDeadlineReject`（保留 fail-closed 语义）                                          |
| `src/tasks/worktree-supervisor.ts`     | waitForSettlement 超时                        | `raceWithDeadlineReject`                                                                   |
| `src/tools/background-manager.ts`      | 后台任务等待超时                              | `raceWithDeadlineReject`                                                                   |
| `src/tools/bash.ts`                    | bash 执行超时 / 强杀定时器                    | `raceWithDeadlineReject`（强杀副作用保留）                                                 |
| `src/tui/system-actions.ts`            | 进程执行超时（2 处）                          | `raceWithDeadlineReject`                                                                   |
| `src/tui/terminal-grid.ts`             | grid 读取超时                                 | `raceWithDeadlineReject`                                                                   |

### C 族：重试退避（sleep 的组合语义）—— 4 处

| 位置                                         | 现状                   | 收敛目标                                                      |
| -------------------------------------------- | ---------------------- | ------------------------------------------------------------- |
| `src/storage/file-history-mutation-lease.ts` | 租约冲突重试退避       | 基于 `sleep` 组合（不引入新原语）或保留（重试策略是业务逻辑） |
| `src/storage/local-file-storage.ts`          | 租约冲突重试退避       | 同上                                                          |
| `src/storage/owner-lease.ts`                 | 租约冲突重试退避       | 同上                                                          |
| `src/runtime/runtime-run.ts`                 | 事件写重试退避（3 处） | 同上                                                          |

### 保留清单（不收敛，白名单保留 + 理由）

- `src/util/race-with-deadline.ts`（canonical）
- `src/daemon/server.ts`（误报：auth 定时器直接 destroy socket，promise 事件驱动）
- `src/memory/worker.ts`（误报：pending 队列 promise + 调度 debounce）
- `src/mobile-gateway/realtime-server.ts`（误报：ws close 事件 promise + 独立 auth 定时器）
- `src/daemon/client.ts` `connectWithTimeout`（**待评估**：socket 事件驱动，若并入会损失结构清晰度则保留，白名单注明"网关层收口范围"）
- C 族重试退避（**待评估**：若判定为业务重试策略而非横切原语则保留，白名单注明）

## 2. 原语设计（`src/util/race-with-deadline.ts` 扩展）

### 2.1 新增 `sleep(ms, options?)`

```ts
/** 纯延迟：resolve 语义。可传 AbortSignal 提前中断（abortableSleep 语义并入）。 */
export function sleep(ms: number, options?: { signal?: AbortSignal }): Promise<void>;
```

- 实现：`setTimeout` resolve + finally clearTimeout（与现有原语一致）+ signal 监听（abort 时 clearTimeout + reject/return）
- **吸收 `retry.ts` 的 `abortableSleep`**（它是 clearTimeout 范式源头，并入后 retry.ts 不再自持实现）
- 注意：`retry.ts` 的 sleep 可能被多处引用——收敛时保持导出名兼容（`retry.ts` re-export 或调用方改 import）

### 2.2 已有原语（不变）

- `raceWithDeadline(target, ms): Promise<boolean>`（resolve-false 排空语义）
- `raceWithDeadlineReject(target, ms, errorFactory): Promise<T>`（reject 请求语义）

## 3. 分批实施（每批独立提交 + 验证）

### 第一批：A 族 sleep/delay → `sleep` 原语（8 处，低风险高收益）

1. 在 `race-with-deadline.ts` 加 `sleep(ms, options?)` + 对应 fixture/集成测试
2. 逐处替换 8 个 delay/sleep helper：
   - 先 Read 确认每个 helper 的签名/行为（是否支持 abort、返回类型）
   - 替换后删除本地 helper
   - **`retry.ts` 的 `abortableSleep` 并入 `sleep(ms, { signal })`**——retry.ts 保留 re-export 或调用方改 import（grep `abortableSleep|sleep(` 找全部调用方）
3. 白名单删对应条目
4. 验证：typecheck 0 + 相关测试（涉及 config-store/retry/atomic-json 的测试）

### 第二批：B 族 reject 超时 → `raceWithDeadlineReject`（15 处）

1. 逐处 Read，核对：
   - 原超时值（保留，如 30s/5s 不变）
   - 原错误类型（errorFactory 产出相同类型：RuntimeClientError/FileLockTimeoutError/裸 Error 等）
   - **副作用保留**（SIGKILL、sseAbort、强杀定时器、fail-closed——副作用放 errorFactory 或 catch，与阶段 1 的 G/I 模式一致）
2. 替换后删本地实现/白名单条目
3. `connectWithTimeout`（daemon/client.ts）单独评估：socket 事件驱动（`connect`/`error` 事件 race 而非 Promise race）——若评估为无法简单并入，保留并白名单注明"网关层收口"；若可并入（如 raceWithDeadlineReject 包 socket 事件 Promise），则并入
4. 验证：typecheck 0 + 相关测试（mcp/daemon/tools/tui 相关集成测试）

### 第三批：C 族重试退避（4 处）——评估后定

1. 判定标准：重试退避是"业务重试策略"（多轮尝试 + 退避曲线）还是"单次超时原语"？
   - 单次超时 → 已由 B 族处理
   - 多轮重试 → **保留**（业务逻辑，不强行收敛）+ 白名单注明"业务重试策略，非横切原语"
2. 如果保留，把白名单条目注释从"既有"改为"业务重试策略（判定保留）"

## 4. 白名单清理规则

- 收敛一处 → 删一处白名单条目（`HANDWRITTEN_TIMEOUT_WHITELIST`）
- 判定保留的 → 更新注释理由（"误报"/"业务策略"/"网关层收口"），**不删除**
- 最终白名单目标：4-6 条（canonical + 3 误报 + 1-2 判定保留）
- 每次删改后跑 `node scripts/check-architecture-boundaries.mjs`（应 0 违规，白名单只是豁免记录）

## 5. 验收标准

- `HANDWRITTEN_TIMEOUT_WHITELIST` 条目数：31 → ≤6（收敛 27 处）
- 全仓 `delay(`/`sleep(` 本地 helper 定义数 = 0（只剩 `src/util/race-with-deadline.ts` 的 `sleep`）
- `grep -rn "function sleep\|function delay\|abortableSleep" src/` —— 本地定义清零（import 引用除外）
- typecheck 0、门禁 0 违规、相关集成测试全绿
- 无行为语义变化：超时值/错误类型/副作用逐处核对一致（每处 before→after 记录在 commit body）

## 6. 风险与注意

1. **`retry.ts` 的 sleep/abortableSleep 被广泛引用**（provider 重试核心）——收敛时保持导出兼容或一次性改所有调用方，勿留半吊子
2. **B 族的副作用是最高风险点**（SIGKILL/sseAbort/强杀——错一个就是行为回归）——逐处核对，宁慢勿错
3. `headless-one-shot-runner.ts` 的 cancel 超时是取消语义（非 deadline）——先区分再改，勿误并入
4. 每个候选收敛后**立即跑该模块的集成测试**（不要攒一批再测）
5. 收敛的最终目标是"横切唯一性门禁无需白名单"——但业务重试策略的保留是合理的（门禁防的是"手写超时原语"，不是"业务循环"）
