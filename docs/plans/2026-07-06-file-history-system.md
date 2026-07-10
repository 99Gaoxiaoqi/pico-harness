# 文件历史系统 Implementation Plan

> **归档状态（2026-07-10）：** 本文保留当时的 CLI 实现计划供追溯，不再作为当前使用说明。当前唯一公开入口是 TUI，文件历史使用 `/snapshots` / `/rewind`；`checkpoint-manager.ts` 只是 legacy/manual fallback。

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans / superpowers:test-driven-development 实现本计划。每个子模块先写测试再写实现,`npm test` 全过后才提交。

**Goal:** 用纯 `copyFile` 备份方案替换 1.2 的 git stash 快照,实现文件回滚与对话回滚解耦的三轴 rewind。

**Architecture:** 新建 `src/safety/file-history.ts`,定义 `FileHistoryState` 状态机 + 一组纯函数(`trackEdit`/`makeSnapshot`/`rewind`)。State 挂载到 `Session` 实例。工具层通过注入的 `preWriteHook` 回调触发 `trackEdit`(不改工具签名)。Loop 每轮结束调 `makeSnapshot`。回滚分三轴:code(文件)、conversation(对话)、both。对话 undo 用 `Session.truncateTo` + JSONL event sourcing 追加 undo 记录。

**Tech Stack:** TypeScript 5.9 + Node 22 ESM + vitest 4 + tsx。无新依赖(用 node:fs/crypto/path/promises)。

---

## 关键设计决策

### D1. 文件布局

```
src/safety/
├── checkpoint-manager.ts    # 保留,1.5.8 后作 fallback
└── file-history.ts          # 新建,本计划核心
src/engine/
├── session.ts               # 改:加 fileHistory 字段 + undo/rewind 方法
└── loop.ts                  # 改:每轮结束调 makeSnapshot
src/tools/
└── registry-impl.ts         # 改:WriteFileTool/EditFileTool 注入 preWriteHook
src/cli/
└── main.ts                  # 改:加 --rewind / --list-snapshots
tests/safety/
└── file-history.test.ts     # 新建,1.5.1~1.5.4 的单元测试
tests/e2e/
└── file-history-e2e.test.ts # 新建,1.5.5 端到端
```

### D2. 备份存储路径

```
~/.pico/file-history/{sessionId}/{sha256(absolutePath).slice(0,16)}@v{version}
```

- 用绝对路径的 sha256 前 16 位做文件名,避免路径分隔符问题
- `@v{version}` 后缀,version 从 1 递增
- lazy mkdir:99% 命中已有目录,只在 ENOENT 时 mkdir + 重试一次

### D3. 工具层接入(不改工具签名)

当前工具构造只接收 `workDir`:`new WriteFileTool(workDir)`。`execute(args)` 只接收 JSON args 字符串。**不改 BaseTool 接口**,改 ToolRegistry 在构造工具时注入 `preWriteHook` 回调:

```typescript
// 新增 ToolRegistry 构造参数
constructor(workDir: string, options?: {
  preWriteHook?: (filePath: string) => Promise<void>;
}) { ... }

// WriteFileTool/EditFileTool 构造增加可选 hook
constructor(workDir: string, private preWriteHook?: (p: string) => Promise<void>) {}

// execute 里写文件前
if (this.preWriteHook) await this.preWriteHook(fullPath);
await writeFile(fullPath, content, "utf8");
```

ToolRegistry 在 loop.ts 里构造时,注入的 hook 闭包 `session.fileHistory` + 当前 messageId。

### D4. 三轴 rewind 语义

| 轴           | 函数                               | 行为                               | 副作用                      |
| ------------ | ---------------------------------- | ---------------------------------- | --------------------------- |
| code         | `rewindCode(messageId)`            | 回滚文件到 messageId 快照,不碰对话 | 无                          |
| conversation | `rewindConversation(messageIndex)` | 截断对话到 messageIndex,不碰文件   | 生成新 conversationId(fork) |
| both         | `rewindBoth(messageId)`            | 两者都做                           | 生成新 conversationId       |

**Fork 语义**:`rewindConversation` 时生成新 `conversationId`,旧 JSONL 保留在磁盘(不删),新会话从截断点 fork 出去。当前 Session 没有 conversationId 字段——1.5.6 新增 `conversationId: string`(初始 = session.id)。

### D5. JSONL event sourcing

Session 当前持久化是**追加**模式(`SessionStore.append`)。undo 不删旧记录,而是追加一条 `{ type: "undo", count, at: timestamp }` 事件。recover 时按事件序列重放:遇到 undo 事件就截断。这保证磁盘记录完整可审计。

### D6. BashTool 重定向检测

1.5.5 要求 BashTool 检测 `>` 重定向时备份目标文件。用正则提取重定向目标:

```typescript
const REDIRECT_RE = /(?:>>|>)\s*(\S+)/g;
function extractRedirectTargets(cmd: string): string[] {
  const targets: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = REDIRECT_RE.exec(cmd)) !== null) {
    targets.push(safeResolve(workDir, m[1]));
  }
  return targets;
}
```

在 BashTool.execute 执行前,对每个 target 调 `preWriteHook`。注意 `>>` 必须在 `>` 之前匹配(已处理)。

---

## 子模块规格

### 1.5.1 数据结构与存储层

**Files:**

- Create: `src/safety/file-history.ts`
- Test: `tests/safety/file-history.test.ts`

**类型定义:**

```typescript
export interface FileHistoryBackup {
  /** 备份文件名(sha256[:16]@v{n}),文件不存在时为 null */
  backupFileName: string | null;
  /** 版本号,从 1 递增 */
  version: number;
  /** 备份时间 */
  backupTime: Date;
}

export interface FileHistorySnapshot {
  /** 对应的 user message id */
  messageId: string;
  /** 该快照点所有被跟踪文件的备份映射 */
  trackedFileBackups: Map<string, FileHistoryBackup>;
  /** 快照时间 */
  timestamp: Date;
}

export interface FileHistoryState {
  /** 所有快照(按时间顺序) */
  snapshots: FileHistorySnapshot[];
  /** 所有被跟踪过的文件绝对路径 */
  trackedFiles: Set<string>;
  /** 快照序列号(用于 version 分配) */
  snapshotSequence: number;
}
```

**存储函数:**

```typescript
/** 生成备份文件名:sha256(absPath).slice(0,16) + "@v" + version */
export function getBackupFileName(filePath: string, version: number): string;

/** 解析备份存储绝对路径 */
export function resolveBackupPath(sessionId: string, backupFileName: string): string;

/** copyFile 备份 + chmod 保留权限,lazy mkdir */
export async function createBackup(
  filePath: string,
  version: number,
  sessionId: string,
): Promise<string /* backupFileName */>;

/** 从备份恢复:copyFile + lazy mkdir 父目录 */
export async function restoreBackup(
  filePath: string,
  backupFileName: string,
  sessionId: string,
): Promise<void>;
```

**测试要求(vitest,expect 风格):**

- `getBackupFileName` 输出格式 `^[0-9a-f]{16}@v\d+$`
- `resolveBackupPath` 路径含 sessionId 和 backupFileName
- `createBackup` → 文件存在 + 内容一致 + 权限一致
- `createBackup` 文件不存在时 throw(由 trackEdit 处理 null)
- `restoreBackup` → 恢复后内容与备份一致
- `restoreBackup` 父目录不存在时自动创建

**提交:** `feat(safety): 文件历史数据结构与存储层`

---

### 1.5.2 写前备份 trackEdit

**Files:**

- Modify: `src/safety/file-history.ts`(追加函数)
- Test: `tests/safety/file-history.test.ts`(追加测试)

**函数:**

```typescript
/**
 * 在 EditTool/WriteTool 执行前调用,保存修改前的原始内容。
 * 去重:同一文件在同一 messageId 轮已跟踪则跳过(不覆盖 v1 备份)。
 * 三阶段:Phase 1 读状态 → Phase 2 async 备份 → Phase 3 提交状态
 */
export async function fileHistoryTrackEdit(
  state: FileHistoryState,
  filePath: string,
  messageId: string,
  sessionId: string,
): Promise<void>;
```

**行为:**

1. 若 `state.trackedFiles` 已含 filePath 且当前 snapshot 的 messageId == 传入 messageId → 跳过(同轮去重)
2. 若文件不存在 → 标记 `backupFileName: null`,加入 trackedFiles
3. 若文件存在 → `createBackup(filePath, version, sessionId)`,version = 该文件已有备份数 + 1
4. 加入 trackedFiles(如果还没在)
5. 不创建 snapshot(snapshot 由 makeSnapshot 在轮末统一做)

**测试:**

- 写文件前 trackEdit → 备份是修改前内容
- 同文件同 messageId 第二次 trackEdit → 跳过(备份不变)
- 不同 messageId 的 trackEdit → 新备份 version +1
- 文件不存在时 trackEdit → backupFileName=null,trackedFiles 含该路径

**提交:** `feat(safety): 写前备份 trackEdit`

---

### 1.5.3 每轮快照 makeSnapshot

**Files:**

- Modify: `src/safety/file-history.ts`
- Test: `tests/safety/file-history.test.ts`

**函数:**

```typescript
/**
 * 每个用户消息结束时调用,遍历 trackedFiles 用 stat(mtime+size)判断变化。
 * 未变 → 复用旧备份(不 copyFile)
 * 变了 → createBackup 新版本
 * 文件被删 → 标记 null
 */
export async function fileHistoryMakeSnapshot(
  state: FileHistoryState,
  messageId: string,
  sessionId: string,
): Promise<void>;

/** 比较 origin 文件当前 stat 与上次备份时的 mtime+size */
async function checkOriginFileChanged(
  filePath: string,
  lastBackup: FileHistoryBackup | undefined,
): Promise<boolean>;
```

**行为:**

1. 创建新 `FileHistorySnapshot { messageId, trackedFileBackups: new Map(), timestamp: new Date() }`
2. 遍历 `state.trackedFiles`:
   - 取该文件最近一次备份(从 snapshots 倒找)
   - `checkOriginFileChanged`:
     - 文件不存在 → 新 backup `{ backupFileName: null, version: lastVersion+1 }`
     - mtime+size 都没变 → 复用 lastBackup(不 copyFile)
     - 变了 → `createBackup(filePath, lastVersion+1, sessionId)`
   - 写入新 snapshot 的 trackedFileBackups
3. `state.snapshots.push(snapshot)`,`state.snapshotSequence++`
4. 若 `snapshots.length > 100` → 删最老的(shift),并清理其独占备份文件

**测试:**

- 改文件 → makeSnapshot → 新版本备份
- 未变文件 → makeSnapshot → 复用旧备份(copyFile 不被调用,可用 spy 验证)
- 删除文件 → makeSnapshot → backupFileName=null
- 100 个快照上限:推 101 个 → 第一个被删

**提交:** `feat(safety): 每轮快照 makeSnapshot`

---

### 1.5.4 回滚 rewind

**Files:**

- Modify: `src/safety/file-history.ts`
- Test: `tests/safety/file-history.test.ts`

**函数:**

```typescript
/**
 * 回滚文件状态到指定 messageId 的快照。
 */
export async function fileHistoryRewind(
  state: FileHistoryState,
  messageId: string,
  sessionId: string,
): Promise<void>;

/** 遍历快照的 trackedFileBackups,逐文件恢复 */
async function applySnapshot(
  state: FileHistoryState,
  target: FileHistorySnapshot,
  sessionId: string,
): Promise<void>;
```

**applySnapshot 行为:**

- 遍历 `target.trackedFileBackups`:
  - `backupFileName == null` → `unlink(filePath)`(Agent 新建的文件被撤销);忽略 ENOENT
  - `backupFileName != null` → `restoreBackup(filePath, backupFileName, sessionId)`
- **不处理 target 之后新增的文件**——这由调用方(rewind)负责:rewind 先找 target snapshot,然后还要扫描后续 snapshot 中出现的"新文件"(backupFileName 从有值变 null 的),一并 unlink

**fileHistoryRewind 行为:**

1. 找到 messageId 对应的 snapshot
2. `applySnapshot(state, snapshot, sessionId)`
3. 截断 `state.snapshots` 到该 snapshot(保留 target 及之前的)
4. 不动 `state.trackedFiles`(保留跟踪记录)

**测试:**

- 改 3 个文件 → rewind → 全部恢复
- 新建文件 → rewind → 文件被 unlink
- rewind 到不存在的 messageId → throw 或 noop(选 throw,便于发现 bug)
- rewind 后再 makeSnapshot → 从截断点继续

**提交:** `feat(safety): 文件回滚 rewind`

---

### 1.5.5 集成到工具系统

**Files:**

- Modify: `src/tools/registry-impl.ts`(WriteFileTool/EditFileTool/BashTool 注入 hook + ToolRegistry 构造参数)
- Modify: `src/engine/session.ts`(加 `fileHistory: FileHistoryState` 字段 + 初始化)
- Modify: `src/engine/loop.ts`(每轮结束调 `fileHistoryMakeSnapshot` + 注入 preWriteHook)
- Test: `tests/e2e/file-history-e2e.test.ts`(新建)

**改动点:**

1. **ToolRegistry 构造** 加 `preWriteHook` 选项,传给 WriteFileTool/EditFileTool/BashTool 构造
2. **WriteFileTool/EditFileTool** execute 里写文件前 `if (this.preWriteHook) await this.preWriteHook(fullPath)`
3. **BashTool** execute 前用 `extractRedirectTargets(cmd)` 提取目标,逐个 `preWriteHook`
4. **Session** 加 `fileHistory: FileHistoryState` 字段,构造时初始化 `{ snapshots: [], trackedFiles: new Set(), snapshotSequence: 0 }`
5. **loop.ts** `run()` 里:
   - 构造 ToolRegistry 时注入 `preWriteHook: (p) => fileHistoryTrackEdit(session.fileHistory, p, currentMessageId, session.id)`
   - turn 结束 `turnSpan?.end()` 之前调 `fileHistoryMakeSnapshot(session.fileHistory, currentMessageId, session.id)`

**currentMessageId 来源:** loop 里 user message append 后,取 `session.getHistory()` 最后一条的 id?当前 Message 类型有没有 id?需要看 schema/message.ts。若无 id,用 `turnCount` 或生成 `${session.id}-${turnCount}`。

**端到端测试:**

- mock provider 返回 edit_file 工具调用 → 执行 → 验证备份自动创建
- 改文件 → 再改 → 验证两个版本备份都在
- BashTool `echo x > foo.txt` → 验证 foo.txt 备份(若之前存在)

**提交:** `feat(engine): 文件历史集成到工具系统`

---

### 1.5.6 对话 undo

**Files:**

- Modify: `src/engine/session.ts`(加 `conversationId` 字段 + `undo(count)` + `rewindTo(messageIndex)`)
- Modify: `src/engine/session-store.ts`(追加 undo 事件 + recover 时重放)
- Test: `tests/engine/session-undo.test.ts`(新建)

**新增字段:**

```typescript
export class Session {
  // ... 现有字段
  /** 当前对话分支 id,初始 = this.id;fork 时生成新的 */
  conversationId: string;
  /** 待处理消息(tool result 到齐前暂存) */
  private deferredMessages: Message[] = [];
  /** 等待中的 tool result id 集合 */
  private pendingToolResultIds: Set<string> = new Set();
}
```

**undo(count):**

```typescript
/**
 * 从 history 末尾向前删 count 个 user prompt 轮次。
 * 跳过 injection 消息(role: system 但非首条),遇到 compaction 边界停止。
 */
undo(count: number): void {
  // 1. 从末尾向前找 count 个 user prompt
  // 2. 截断到第 count 个 user prompt 之前
  // 3. 清空 deferredMessages / pendingToolResultIds
  // 4. 持久化:追加 { type: "undo", count, at: new Date() } 到 JSONL
}
```

**rewindTo(messageIndex):**

```typescript
rewindTo(messageIndex: number): void {
  // 截断 history 到 messageIndex(不含)
  // 用现有 truncateTo(messageIndex)
  // 清空 deferredMessages
  // 持久化 undo 事件
}
```

**JSONL event sourcing:**

- SessionStore.append 追加普通消息(已有)
- 新增 SessionStore.appendUndoEvent(count | messageIndex)
- recover() 重放:遇到 undo 事件 → truncateTo

**测试:**

- 对话 5 轮 → undo(2) → 只剩 3 轮
- undo 到 compaction 边界停止(不越过)
- undo 后 deferredMessages 清空
- undo 后持久化 → recover → 状态一致

**提交:** `feat(engine): 对话 undo 与 rewindTo`

---

### 1.5.7 三轴选择

**Files:**

- Modify: `src/safety/file-history.ts`(加 `rewindCode`)
- Modify: `src/engine/session.ts`(加 `rewindConversation`/`rewindBoth`)
- Test: `tests/safety/file-history.test.ts` + `tests/engine/session-undo.test.ts`(追加)

**函数:**

```typescript
// file-history.ts
export async function rewindCode(
  state: FileHistoryState,
  messageId: string,
  sessionId: string,
): Promise<void> {
  return fileHistoryRewind(state, messageId, sessionId);
}

// session.ts
rewindConversation(messageIndex: number): void {
  this.rewindTo(messageIndex);
  this.conversationId = `${this.id}-${Date.now().toString(36)}`;
  // fork:新 conversationId,旧 JSONL 保留
}

async rewindBoth(messageId: string): Promise<void> {
  // 找 messageId 对应的 messageIndex
  const idx = this.findIndexByMessageId(messageId);
  await rewindCode(this.fileHistory, messageId, this.id);
  this.rewindConversation(idx);
}
```

**测试:**

- rewindCode 只回滚文件,对话 history 不变
- rewindConversation 只截断对话,文件不变,conversationId 变化
- rewindBoth 两者都做
- fork 后 conversationId 唯一性

**提交:** `feat(engine): 三轴 rewind 选择`

---

### 1.5.8 CLI 集成 + 替换旧方案

**Files:**

- Modify: `src/cli/main.ts`(加 `--rewind` / `--list-snapshots` 命令)
- Modify: `src/safety/checkpoint-manager.ts`(标记为 fallback,加 deprecation 注释)
- Modify: `AGENTS.md` + `ROADMAP.md`(文档更新)
- Test: `tests/e2e/file-history-e2e.test.ts`(追加 CLI 测试)

**CLI 命令:**

```
pico --list-snapshots <sessionId>
# 输出:快照列表 + 每个快照的文件变更数

pico --rewind <message-id> --axis code|conversation|both
# 执行三轴 rewind
```

**保留 checkpoint-manager.ts:**

- 加注释 `@deprecated 1.5 后用作非交互场景 fallback,新代码用 file-history`
- 不删,不在 main path 调用

**全量测试:** `npm test` 全过

**提交:** `feat(cli): --rewind 与 --list-snapshots 命令`

---

## 依赖关系与实现顺序

```
1.5.1 (存储层)  ← 无依赖,最先做
  ↓
1.5.2 (trackEdit)  ← 依赖 1.5.1 的 createBackup
  ↓
1.5.3 (makeSnapshot)  ← 依赖 1.5.1/1.5.2
  ↓
1.5.4 (rewind)  ← 依赖 1.5.1/1.5.3
  ↓
1.5.5 (集成工具)  ← 依赖 1.5.2/1.5.3,改 Session/loop/tools
  ↓
1.5.6 (对话 undo)  ← 依赖 1.5.5 的 Session 改动,可与 1.5.7 部分并行
  ↓
1.5.7 (三轴)  ← 依赖 1.5.4/1.5.6
  ↓
1.5.8 (CLI)  ← 依赖 1.5.7
```

**严格顺序**:1.5.1 → 1.5.2 → 1.5.3 → 1.5.4 → 1.5.5 → 1.5.6 → 1.5.7 → 1.5.8

每个子模块:TDD(先测试后实现) → `npm test` 全过 → git commit → 更新 ROADMAP 勾选。

---

## Worktree 流程

```bash
git worktree add ../pico-1.5-file-history -b feat/file-history
cd ../pico-1.5-file-history
# ... 8 个子模块依次实现 ...
# 完成后:
cd ../pico-harness
git merge feat/file-history
git worktree remove ../pico-1.5-file-history
```

---

## 参考资源

- 现有 `src/safety/checkpoint-manager.ts`(156 行)——风格参考
- 现有 `tests/safety/checkpoint.test.ts`(119 行)——测试风格参考
- `src/engine/session.ts`——Session 类,`truncateTo` 可复用
- `src/engine/loop.ts`——run() 方法 line 378,turn 边界 line 619
- `src/tools/registry-impl.ts`——WriteFileTool line 319,BashTool line 392,EditFileTool line 654
