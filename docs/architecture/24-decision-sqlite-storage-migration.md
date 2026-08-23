# 24. 架构决策:存储层全面迁移 SQLite

状态：已实施。本文是迁移的总设计与实施记录；当前生产路径已统一使用 workspace
`pico.sqlite`，旧 JSONL 纪元不再提供产品读写路径。设计期个别实现选型后来发生调整：例如
数据库副本当前使用 `VACUUM INTO`，不是下文最初设想的模块级 `backup()`；最终事实以代码为准。

## 1. 背景实证

文件载体(JSONL/JSON + 目录锁 + 自研 WAL)的三项结构性代价:

1. **读面全量解析**:`runtime-event-store.ts` 除 `loadManifestProjectionFast` 外所有读方法走 `loadSession` 整文件 parse;分页是内存切片。放大点:compaction 一次 ≥3 次全量读;memory worker 每 Job 4 次全量;memory 崩溃恢复 O(全部会话×全部事件);`appendBatch` 写路径 `requireSession` 全量读去重。
2. **锁仪式**:`.storage/lock` 全局 OwnerLease + 每锁 `recoverFileTransactionSync` ≈ 40ms/会话(TUI 历史加载慢的根因,2026-08-18 的 A/B 优化只消放大不消锁)。
3. **自研 WAL**:`commit.json` 三阶段 + 前后哈希 CAS,是在文件系统上模拟数据库事务;control/memory 整文档重写。

maka 深潜关键结论(修正先前认知):maka 事实表 `runtime_events.payload_json` = **完整 canonical JSON 原样**,不裁剪不拆列。"深"在结构:身份列拆出做索引 + 大量投影表**同事务增量维护** + 消息独立成表。pico 的"payload=事实本体、裁剪 taboo"语义与之一致,无需放弃。

## 2. 决策

1. **深迁移,照 maka 做法**:事实进 SQLite 结构化表,投影同事务物化,消息独立成表;事件 payload 完整保留。
2. **单库**:每 workspace 一个 `<storageRoot>/pico.sqlite`(WAL),所有 scope 共库共连接;跨域事务消灭 `commit.json`。
3. **锁模型整套退役**:`.storage/lock`、`commit.json`、能力探针、`withLedgerStoreLock` 仪式全部退役,换 `BEGIN IMMEDIATE`(写)+ WAL + `busy_timeout=5000` + 只读连接(`readOnly:true` + `query_only=ON`)。单写者成立:全部客户端(含 headless-one-shot-runner)只经 daemon connect-or-spawn 连接。
4. **不做存量迁移/导入**:切换即新纪元,旧 JSONL workspace 不导入、历史作废。以 layout 版本门禁 fail-closed 拒绝新旧混写(检测到 session-centric-v1 布局 = 旧纪元,拒绝打开并提示)。
5. **blob 本体留文件系统**:evidence/file-history 的 CAS blob 目录结构不变,库内只存索引(≈maka artifact 模式)。
6. **配置面不迁**:`PICO_HOME` 级 config/mcp/hooks/plugins/trust 等继续 JSON(用户手可编辑性);traces 留 FS;fork-staging 留 FS。

### 弃案

- **浅迁移(仅换载体)**:治标不治本,投影/锁/事务三痛点一个不消。
- **拆 payload 为投影增量**:maka 实测也不这么做(payload 完整存储);pico 17 个 durable topic 实证余量三个数量级,无压力。
- **双写过渡/导入工具**:单用户本地产品,无在线迁移需求;用户拍板存量作废,导入工具整体砍掉。
- **不迁 SQLite(2026-08-18 上午的分期结论)**:被本决策推翻——TUI 慢根因链显示锁成本不随放大优化消失,终态结构消除优于逐项修剪。

### 代价

- JSONL 人类直读性(cat/grep 肉眼检查)消失;补偿=doctor 查询化 + 后续可加 SQL 导出命令。
- `engines` 提窗 `>=22.13` → `>=22.19`(node:sqlite `backup()` 等模块级 API)。
- `synchronous=FULL`(maka 同款,每 commit fsync)写吞吐低于 NORMAL;**2026-08-18 本机(Windows/NTFS)实测**:模拟 pico 写模式(每事务 5 事件×~2KB payload + 会话水位 UPDATE)FULL=3.7~7.9ms/tx、NORMAL=1.2~2.2ms/tx(FULL 波动来自 AV/索引器),远低于 50ms 复评阈值——采用 FULL,基准脚本 `.scratch/sqlite-migration/bench-sync.mjs`。
- 测试面对 JSONL 形状的断言成批改写。

### 复评条件

- 若 Windows AV/索引器反复锁 `-wal/-shm` 导致 daemon 不可用 → 评估 `journal_mode=DELETE` 回退。
- 若 FULL 同步成为可测瓶颈(批提交 >50ms)→ 降 NORMAL 并补崩溃一致性测试。

## 3. 连接层设计(照抄 maka)

- 进程内单连接 Owner + Lease 引用计数(`acquireOperationalDatabase(storageRoot)`),无连接池;事务集中:写 `BEGIN IMMEDIATE`、读 `BEGIN`(deferred),嵌套折叠。
- 打开即 PRAGMA:`busy_timeout=5000`、WAL(持久属性:老库只校验,设置撞 BUSY 以 10ms 重试至 5s)、`synchronous=FULL`、`foreign_keys=ON`。
- 只读消费者开第二连接 `readOnly:true` + `query_only=ON`,不迁移、只校验版本,超前拒绝打开。
- schema migration:每 scope 一个 `Map<version, SQL>`;打开时自动逐级、单事务(`BEGIN IMMEDIATE` 后重读版本防并发双跑);scope 版本注册于 `operational_schema_migrations(scope, version, applied_at)`。
- 防漂移断言:`:memory:` 跑全套迁移得到目标 schema,`sqlite_schema` 逐对象规范化 diff(`normalizeSql`),不一致拒绝开库。
- backup：当前实现使用 `VACUUM INTO` 生成自包含副本，再执行完整性校验；本项与设计初稿不同。

## 4. Schema 设计

库文件:`pico.sqlite`。新 layout 标识 `sqlite-centric-v1`(workspace-storage-layout v3),`storageRootId` + `physicalIdentity` 语义保留。scope 划分: `sessions` / `task_runs` / `control` / `memory` / `operations` / `attachments`(file-history + evidence)/ `kv`。

通用约定:`payload_json`/`*_json` 列 = canonical JSON(键排序 stringify),完整保留现有类型与 `assertRuntimeEvent` 校验路径,decode = `JSON.parse` 后走既有校验;其余列是索引投影,不含独家信息。时间戳:pico 现状 ISO 字符串 → TEXT(字典序可排序);control 面现状 epoch 毫秒 → INTEGER。

### 4.1 scope `sessions`(核心)

事件事实表(信封列照 `RuntimeEventBase` 全量拆出):

```sql
CREATE TABLE runtime_events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  invocation_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL CHECK (event_seq > 0),
  kind TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('model','transcript','internal')),
  partial INTEGER NOT NULL CHECK (partial IN (0,1)),
  tx_id TEXT NOT NULL,
  tool_call_id TEXT,            -- refs.toolCallId 投影(可空)
  provider_call_id TEXT,        -- refs.providerCallId 投影(可空)
  operation_id TEXT,            -- plan/graph CAS 身份投影(可空)
  payload_json TEXT NOT NULL,   -- 完整事件对象 canonical JSON
  at TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  UNIQUE (session_id, event_seq)
);
CREATE INDEX runtime_events_by_run ON runtime_events(session_id, run_id, event_seq);
CREATE INDEX runtime_events_by_kind ON runtime_events(session_id, kind, event_seq);
CREATE INDEX runtime_events_by_tool_call ON runtime_events(tool_call_id) WHERE tool_call_id IS NOT NULL;
CREATE INDEX runtime_events_by_operation ON runtime_events(session_id, operation_id) WHERE operation_id IS NOT NULL;
```

`event_seq` 分配 = `SELECT COALESCE(MAX(event_seq),0)+1 WHERE session_id=?`(BEGIN IMMEDIATE 保证独占)。append 幂等 = 事前按 `event_id` 点查 + 深比较,冲突抛错、完全重复返回既有 seq(替代现在 `requireSession` 全量读去重)。

会话表(吸收 header + manifest 投影 + desktop session-state):

```sql
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  work_dir TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_event_seq INTEGER NOT NULL DEFAULT 0,
  last_tx_id TEXT,
  event_count INTEGER NOT NULL DEFAULT 0,
  storage_bytes INTEGER NOT NULL DEFAULT 0,   -- sum(length(payload_json))
  fork_parent_session_id TEXT,                -- session.forked 同事务维护
  archived_at INTEGER,                        -- 原 desktop session-state 并入
  pinned_at INTEGER,
  updated_at TEXT NOT NULL
);
```

目录投影表(结构列随 sessions UPDATE 触发器维护;title/preview/message_count 由 append 事务应用层维护,maka 双轨):

```sql
CREATE TABLE session_catalog_projection (
  session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  activity_at TEXT NOT NULL,                  -- COALESCE(last_message_at, created_at)
  title TEXT,
  last_message_preview TEXT CHECK (last_message_preview IS NULL OR length(last_message_preview) <= 96),
  message_count INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL CHECK (is_archived IN (0,1)),
  is_pinned INTEGER NOT NULL CHECK (is_pinned IN (0,1)),
  fork_parent_session_id TEXT,
  is_published INTEGER NOT NULL DEFAULT 0     -- isPublishedRuntimeSession 判定物化
);
CREATE INDEX catalog_by_activity ON session_catalog_projection(activity_at DESC, session_id ASC);
CREATE INDEX catalog_by_archived_activity ON session_catalog_projection(is_archived, activity_at DESC, session_id ASC);
CREATE INDEX catalog_by_pinned_activity ON session_catalog_projection(is_pinned, is_archived, activity_at DESC, session_id ASC);
```

消息表(`message.committed` 的同事务物化投影,可从事件重建;启动恢复直接读本表、不再全量重放):

```sql
CREATE TABLE session_messages (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,                  -- 对应事件 seq(消息身份锚)
  event_id TEXT NOT NULL UNIQUE,
  message_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('system','user','assistant')),
  message_ts TEXT NOT NULL,
  payload_json TEXT NOT NULL,                 -- Message 对象 canonical JSON
  PRIMARY KEY (session_id, sequence)
);
CREATE INDEX session_messages_by_message_id ON session_messages(session_id, message_id);
CREATE INDEX session_messages_by_ts ON session_messages(session_id, message_ts, sequence);
```

transcript UI 卡片(`transcript.event.recorded`)不建独立表,按 `runtime_events_by_kind` 索引投影。compaction checkpoint 查找 = `by_kind` 取末条。会话列表 = catalog 单条 keyset SQL(游标 `{activityAt, sessionId}`,页 32/上限 128/limit+1 判 hasMore)。

### 4.2 scope `task_runs`

```sql
CREATE TABLE task_runs (
  task_run_id TEXT PRIMARY KEY,
  work_dir TEXT NOT NULL,
  storage_root_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  adapter_version INTEGER NOT NULL,
  adapter_input_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  max_attempts INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  last_event_seq INTEGER NOT NULL DEFAULT 0,
  last_tx_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0,        -- expectedRevision CAS 保持
  status TEXT,                                -- 投影列(可重建)
  updated_at TEXT NOT NULL
);
CREATE TABLE task_run_events (
  event_id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL REFERENCES task_runs(task_run_id) ON DELETE CASCADE,
  event_seq INTEGER NOT NULL CHECK (event_seq > 0),
  kind TEXT NOT NULL,
  tx_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  UNIQUE (task_run_id, event_seq)
);
CREATE INDEX task_run_events_by_kind ON task_run_events(task_run_id, kind, event_seq);
```

### 4.3 scope `control`(RuntimeStore 三件套 → 表)

```sql
CREATE TABLE control_metadata (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
-- revision / lastTransactionId / nextRuntimeEventSequence

CREATE TABLE jobs (
  job_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','partial','failed','timed_out','cancelled','interrupted')),
  execution_class TEXT NOT NULL CHECK (execution_class IN ('host_bound','recoverable')),
  completion_policy TEXT NOT NULL CHECK (completion_policy IN ('required','optional','detached')),
  description TEXT NOT NULL,
  owner_session_id TEXT, child_session_id TEXT, tool_use_id TEXT, output_path TEXT,
  data_json TEXT, version INTEGER NOT NULL, lease_epoch INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  terminal_at INTEGER, error TEXT
);
CREATE INDEX jobs_by_status ON jobs(status, updated_at);

CREATE TABLE job_attempts (
  attempt_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL, status TEXT NOT NULL, owner_id TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL, output_path TEXT, output_offset INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER,
  error TEXT, result_json TEXT, version INTEGER NOT NULL,
  UNIQUE (job_id, attempt_number)
);

CREATE TABLE runtime_leases (
  resource_key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL, lease_epoch INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, version INTEGER NOT NULL
);
CREATE INDEX runtime_leases_by_expiry ON runtime_leases(expires_at);

CREATE TABLE cron_jobs (
  cron_job_id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL, name TEXT NOT NULL,
  schedule TEXT NOT NULL, time_zone TEXT NOT NULL, prompt TEXT NOT NULL,
  enabled INTEGER NOT NULL, policy_snapshot_json TEXT NOT NULL,
  credential_ref TEXT, model_route_id TEXT,
  version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE cron_runs (
  cron_run_id TEXT PRIMARY KEY,
  cron_job_id TEXT NOT NULL REFERENCES cron_jobs(cron_job_id) ON DELETE CASCADE,
  workspace_path TEXT NOT NULL, scheduled_for INTEGER NOT NULL,
  status TEXT NOT NULL, owner_id TEXT, lease_epoch INTEGER NOT NULL,
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
  reason TEXT, result_json TEXT, version INTEGER NOT NULL
);
CREATE INDEX cron_runs_by_job ON cron_runs(cron_job_id, scheduled_for DESC);

CREATE TABLE daemon_commands (
  idempotency_key TEXT PRIMARY KEY, command_type TEXT NOT NULL,
  request_hash TEXT NOT NULL, request_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','completed')),
  result_json TEXT, resource_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE daemon_runs (
  run_id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL, session_id TEXT, checkpoint_id TEXT,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','pause_requested','paused','cancelling','succeeded','failed','cancelled')),
  started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER,
  error TEXT, result_json TEXT, version INTEGER NOT NULL
);
CREATE TABLE job_commands (
  command_id TEXT PRIMARY KEY, job_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('cancel','message')),
  payload_json TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER
);
CREATE TABLE completion_outbox (
  completion_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt_id TEXT,
  policy TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT,
  created_at INTEGER NOT NULL, delivered_at INTEGER
);
CREATE INDEX completion_outbox_undelivered ON completion_outbox(created_at) WHERE delivered_at IS NULL;
CREATE TABLE merge_requests (
  merge_request_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt_id TEXT,
  source_branch TEXT NOT NULL, source_worktree TEXT NOT NULL,
  target_branch TEXT NOT NULL, target_worktree TEXT NOT NULL, source_head TEXT,
  status TEXT NOT NULL, error TEXT, version INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

-- 事实账本(原 daemon-events.jsonl)
CREATE TABLE daemon_events (
  event_id TEXT PRIMARY KEY, tx_id TEXT NOT NULL,
  sequence INTEGER NOT NULL UNIQUE,
  topic TEXT NOT NULL, workspace_path TEXT, cron_job_id TEXT, cron_run_id TEXT,
  payload_json TEXT, created_at INTEGER NOT NULL
);
-- 事实账本(原 usage-ledger.jsonl)
CREATE TABLE usage_provider_calls (
  call_id TEXT PRIMARY KEY, tx_id TEXT NOT NULL, session_id TEXT, conversation_id TEXT,
  goal_id TEXT, job_id TEXT, attempt_id TEXT,
  purpose TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, route TEXT,
  status TEXT NOT NULL CHECK (status IN ('succeeded','failed','cancelled')),
  input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL,
  cost REAL NOT NULL, reported_json TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX usage_calls_by_session ON usage_provider_calls(session_id, created_at DESC);
CREATE INDEX usage_calls_by_created ON usage_provider_calls(created_at DESC);
CREATE TABLE usage_baselines (
  baseline_id TEXT PRIMARY KEY, session_id TEXT, goal_id TEXT,
  input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL,
  cost REAL NOT NULL, imported_at INTEGER NOT NULL, source_json TEXT
);
```

control 事务 = 单 `BEGIN IMMEDIATE` 内多表写 + `control_metadata.revision` CAS,替代现在 state.json 整写 + 双 jsonl append 三文件联动。

### 4.4 scope `memory`

```sql
CREATE TABLE memory_metadata (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
-- revision / settings / workspaceId

CREATE TABLE memory_sources (
  source_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT,
  event_ids_json TEXT NOT NULL, start_sequence INTEGER, end_sequence INTEGER,
  digest TEXT NOT NULL, evidence_ref_json TEXT,
  availability TEXT NOT NULL CHECK (availability IN ('available','unavailable')),
  extraction_suppressed_at TEXT, invalidated_at TEXT, invalidation_code TEXT,
  version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX memory_sources_by_session ON memory_sources(session_id);

CREATE TABLE memory_facts (
  fact_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('preference','correction','project_fact','reference')),
  title TEXT, content TEXT, confidence REAL NOT NULL, source_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('active','disabled','archived','forgotten')),
  pinned INTEGER NOT NULL, expires_at TEXT, last_used_at TEXT,
  version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, forgotten_at TEXT
);
CREATE INDEX memory_facts_injection ON memory_facts(state, pinned DESC, updated_at DESC) WHERE state = 'active';

CREATE TABLE memory_proposals (
  proposal_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL, title TEXT, content TEXT, reason TEXT, confidence REAL NOT NULL,
  source_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected','deleted')),
  conflict_status TEXT NOT NULL CHECK (conflict_status IN ('none','potential','confirmed','resolved')),
  conflict_fact_id TEXT, resolved_fact_id TEXT,
  version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  reviewed_at TEXT, deleted_at TEXT
);
CREATE INDEX memory_proposals_pending ON memory_proposals(updated_at DESC) WHERE status = 'pending';

CREATE TABLE memory_mutations (
  sequence INTEGER PRIMARY KEY,
  mutation_id TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('settings','fact','proposal','source','job')),
  entity_id TEXT NOT NULL, action TEXT NOT NULL,
  from_version INTEGER, to_version INTEGER NOT NULL,
  idempotency_key_hash TEXT CHECK (idempotency_key_hash IS NULL OR length(idempotency_key_hash) = 64),
  created_at TEXT NOT NULL
);

CREATE TABLE memory_jobs (
  job_id TEXT PRIMARY KEY, type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  terminal_event_id TEXT NOT NULL, extractor_version TEXT NOT NULL,
  cursor_json TEXT NOT NULL, source_id TEXT,
  attempt_count INTEGER NOT NULL, max_attempts INTEGER NOT NULL, next_attempt_at TEXT,
  error_code TEXT, model_calls INTEGER NOT NULL, input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL, cost_usd REAL NOT NULL,
  version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, terminal_at TEXT,
  UNIQUE (terminal_event_id, extractor_version)
);

CREATE TABLE memory_idempotency (
  operation_key TEXT PRIMARY KEY,            -- `${operation}:${keyHash}`
  request_hash TEXT NOT NULL, marker_json TEXT NOT NULL, created_at TEXT NOT NULL
);
```

### 4.5 scope `operations`(fork/rewind Saga)

```sql
CREATE TABLE storage_operations (
  operation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('rewind','fork')),
  version INTEGER NOT NULL,                   -- 乐观并发,advance 校验
  state TEXT NOT NULL CHECK (state IN ('prepared','workspace_applied','session_committed','sidecars_committed','completed','aborted','needs_attention')),
  session_id TEXT NOT NULL, target_session_id TEXT,
  operation_json TEXT NOT NULL,               -- 完整操作记录(含 dispositions/error)
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX storage_operations_unfinished ON storage_operations(updated_at) WHERE state NOT IN ('completed','aborted');
```

`indexForkTargetOperations` 全目录扫描变一条小查询。

### 4.6 scope `attachments`(file-history + evidence 索引;blob 留 FS)

```sql
CREATE TABLE evidence_records (
  session_id TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  kind TEXT NOT NULL CHECK (kind IN ('tool-exchange','subagent-report')),
  archived_at TEXT NOT NULL,
  content_json TEXT NOT NULL,                 -- 清单正文(小;rawOutput/report 是 blobRef)
  PRIMARY KEY (session_id, content_hash)
);
CREATE TABLE evidence_blobs (
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (digest)                        -- 本体在 FS:blobs/sha256/<xx>/<digest> 不变
);
CREATE TABLE file_history (
  session_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  snapshot_sequence INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL,                   -- roots/trackedFiles/fileVersions(低频)
  updated_at TEXT NOT NULL
);
CREATE TABLE file_history_snapshots (
  session_id TEXT NOT NULL,
  before_session_seq INTEGER NOT NULL,
  message_id TEXT NOT NULL, source_message_event_id TEXT NOT NULL,
  message_index INTEGER NOT NULL, user_prompt TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,                -- backups/editedFilePaths/journalWarnings
  PRIMARY KEY (session_id, before_session_seq)
);
```

### 4.7 scope `kv`

```sql
CREATE TABLE workspace_kv (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
-- todo.json 迁入(顺带获得事务原子性);hooks-state/plugins workspace 态按需迁入
```

## 5. 实施记录（已完成）

每阶段一条集成测试验收;涉及读路径的阶段追加真机 TUI 计时对比(基线:2026-08-18 A/B 后 ~0.85s)。

| 阶段 | 内容                                                                                                                                                                                                                                     | 验收                                  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| M0   | 本文 ADR 定稿                                                                                                                                                                                                                            | 用户批准(已完成)                      |
| M1   | `src/storage/sqlite/` 引擎层:Owner/Lease、PRAGMA 组合、migration 框架 + `:memory:` 形状断言、只读连接、backup;workspace-storage-layout v3(`sqlite-centric-v1`)+ 旧布局 fail-closed 门禁;engines 提窗 `>=22.19`;FULL vs NORMAL 写吞吐实测 | 引擎层冒烟 + 旧布局拒绝打开测试       |
| M2   | 会话纵切片:`sessions`/`runtime_events`/`session_catalog_projection`/`session_messages` 四表 + append/read/summary/keyset 分页全切换;desktop session-state 并入;`appendBatch` 幂等变事件点查                                              | 建会话→多轮→fork→列表→resume 集成测试 |
| M3   | 读消费面受益确认:session.list/findCliSessionSummary/compaction/memory 恢复/plan/graph 投影改 SQL 查询;manifest.json 投影退役                                                                                                             | 真机 TUI 计时 + compaction 路径测试   |
| M4   | `control` + `task_runs` + `memory` scope 切换;崩溃恢复重写(恢复=查询)                                                                                                                                                                    | 恢复路径集成测试                      |
| M5   | `attachments` + `operations` + `kv`:file-history/evidence 索引入库、journal 入库、todo 迁入                                                                                                                                              | rewind/fork e2e                       |
| M6   | 退役清理:JSONL 写路径、`.storage/lock`/`commit.json`/能力探针、doctor 重写(现 sqlite legacy 检测反转语义)、portability 重写(pico.sqlite 登记为 portable 单文件 + blob 目录)                                                              | doctor 干净 + 全链路 e2e              |

依赖关系:M1 → M2 → M3 → M4/M5(可并行)→ M6。M2 是最窄也最关键的纵切片——它单独成立即可让 TUI 列表/会话恢复脱离 JSONL。
