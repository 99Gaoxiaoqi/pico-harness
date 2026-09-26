# 上下文历史离线清理

`reset-context-history.mjs` 是一次性维护入口，供上下文体系升级前清除运行历史。它不参与产品启动或兼容读取。

必须先退出 Pico App，停止 RuntimeHost、CLI、调度器以及其他访问目标库的写入进程，并在清理与升级结束前保持停止。`--runtime-stopped` 是操作者对这个前提的声明，脚本不会杀进程。

先明确传入每一个目标数据库，查看清理清单：

```sh
node scripts/maintenance/reset-context-history.mjs --database /absolute/workspace/pico.sqlite --dry-run
```

确认进程已停止后执行：

```sh
node scripts/maintenance/reset-context-history.mjs --database /absolute/workspace/pico.sqlite --execute --runtime-stopped
```

可以重复传入 `--database`，但每个数据库分别提交事务，不提供跨数据库原子性。缺少 `--execute` 时默认只读。路径必须指向已有普通文件；脚本不扫描目录、不新建库。

## 删除与保留

- 删除目标库中的会话、事件、消息及投影、checkpoint、工具日志、partial、研究记录、任务和图运行事实、文件历史、归档引用、会话 artifact blob、用量物理记录及 owner/revision/tombstone、队列与幂等状态、定时任务执行记录，以及 `event_log_epoch` 中的旧运行事件标识。
- `workspace_kv` 仅删除 `desktop.side-chat.leases.v1`，清除边聊会话引用；工作区 todo 和其他配置键原样保留。
- 完整保留 `operational_schema_migrations`、`workspace_storage_binding`、`cron_jobs`。事务内比较保留数据摘要，出现意外改动则回滚。
- 不打开连接凭证、项目配置、信任配置、独立长期记忆库或业务文件。长期记忆中的历史来源属于记忆出处，原样保留。
- `runtime_storage_assets` 的外部 URI、digest 与字节数会在报告 `externalAssets` 中列出；脚本**不跟随 URI 删除任何文件**。数据库内归档引用随事务清除，外部文件只能在另行确认属于 Pico 托管内容后处理。报告包含 `externalFilesDeleted: 0`。

## 校验与升级

只支持 `control` scope 版本 7 或 8；未知表、其他版本、完整性异常均拒绝操作。按实际外键依赖顺序删除，不关闭外键；session 删除触发器产生的用量 tombstone 也清空。单库事务结束前检查所有执行表为空、边聊引用消失、保留数据不变、`foreign_key_check` 无错误、`quick_check` 为 `ok`。失败回滚全部删除。

脚本不会修改 schema registry 或 `user_version`。清理 v7 后，由新版本 RuntimeHost 正常打开空历史数据库并运行现有 v8 migration。运行事件标识被清空后，当前 RuntimeHost 会在空历史数据库中重新写入 `runtime-event-v2`；本次清理不新增版本或旧标识兼容逻辑。再次执行清理保持幂等。

验证命令：

```sh
node --import tsx --test tests/integration/storage/context-reset-maintenance.test.ts
```

测试仅使用临时目录，覆盖 v7/v8、只读预览、清理后初始化新标识和会话、清理后升级、保留真实长期记忆库与 cron 定义、重复清理、事务失败回滚和未知表拒绝。
