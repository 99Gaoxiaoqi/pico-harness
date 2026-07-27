# ToolResult 事实、证据与模型投影

## 目标

大型 ToolResult 必须同时满足四个约束：

1. 工具真实返回值是可恢复、可校验的 Runtime 事实；
2. 大正文只保存一份，不同时写 ToolResult Artifact 与 Runtime Evidence；
3. 模型默认只看到有界、确定性的工具感知预览，并可按需分页回读原文；
4. 上下文压缩只能改变模型投影，不能改写已经发生的工具事实。

本次变更采用 `RuntimeEvent + EvidenceArchive + request projection`，不把大型正文直接嵌入
Session JSONL，也不把 LLM 摘要放进工具执行的同步提交路径。

## Canonical Event

新增 model-visible RuntimeEvent：

```ts
interface RuntimeToolResultRecordedEvent {
  kind: "tool.result.recorded";
  refs: {
    toolCallId: string;
    evidence?: RuntimeEvidenceReference;
  };
  data: {
    toolName: string;
    status: "succeeded" | "failed" | "rejected" | "cancelled" | "interrupted";
    body:
      | {
          storage: "inline";
          content: string;
          sha256: string;
          sizeBytes: number;
        }
      | {
          storage: "evidence";
          sha256: string;
          sizeBytes: number;
        };
    projection: {
      version: 1;
      mode: "full" | "preview" | "synthetic";
      text: string;
      strategy: string;
      truncated: boolean;
    };
  };
}
```

- `body` 是工具执行事实。Evidence 写入成功时只保存引用及完整性元数据；写入失败时
  fail-open 为 `inline`，不允许只留下截断文本。
- `projection` 是可丢弃、可重建的派生数据。当前 Turn 只允许确定性预览，不调用 LLM。
- `refs.toolCallId` 必填；`body.storage === "evidence"` 时 `refs.evidence` 必填。
- `body.sha256/sizeBytes` 始终针对原始 `ToolResult.output`，不包含 Recovery 提示或 preview。
- 旧 `message.committed` ToolResult 继续投影，支持现有 Session、fork seed 与兼容宿主。

## 写入顺序

```text
tool.execute
  → 计算 raw sha256 / chars / bytes
  → 生成确定性 full/preview 投影
  → EvidenceArchive manifest 写入 raw blob ref
      ├─ 成功：register evidence ref
      └─ 失败：记录告警并选择 inline raw
  → 原子提交 tool.result.recorded 批次
  → Session 从 durable event 物化 Message
  → Reporter/UI 消费同一模型投影
```

工具结果必须在 RuntimeEvent durable 后才进入 Session 内存投影。并发工具批次仍保持 assistant
toolCalls 后紧邻全部 ToolResult 的协议顺序。

## 投影策略

- 默认单条结果上限：估算 `2,048 tokens`；
- 使用项目现有 `countTokens()`，tokenizer 未就绪时才回退 `chars / 4`；
- 小结果投影为 `full`；
- 大结果通过现有 tool-aware summarizer 生成不超过约 1,600 字符的 `preview`；
- `read_evidence` 与旧 `read_artifact` 不再次归档，避免回读递归；
- preview 必须携带工具名、原始大小、hash、evidence URI 和明确回读动作；
- LLM 语义摘要只用于后续 FullCompaction，不参与当前 ToolResult 提交。

## Evidence 回读

新增只读能力：

```text
read_evidence(ref, offsetBytes?, limitBytes?)
```

`ref` 是不可伪造为任意文件路径的 `pico://evidence/...` 引用。大正文写入
`workspace.evidence/blobs/sha256/<prefix>/<digest>`，Evidence manifest 只保存 BlobRef。
读取时必须验证：

- evidence root 边界；
- session 与 content hash；
- manifest 内容 hash；
- blob size 与 SHA-256；
- blob 和 manifest 都必须是普通文件而不是 symlink；
- UTF-8 分页边界；
- 单页上限。

旧 `read_artifact` 保留，用于兼容 Artifact 和子代理报告。

## 存储与兼容

- 生产 Runtime ToolResult 不再写短期 ToolResultArtifactStore；Evidence 下的 SHA-256 CAS 是唯一大正文。
- ToolResultArtifactStore 继续服务旧宿主、子代理报告和历史 Artifact，暂不迁移磁盘布局。
- Existing EvidenceArchive v1 manifest 保持可读；新 v2 manifest 引用 BlobRef，不再内嵌
  `rawOutput` 与 `modelVisibleOutput`。
- Fork 在同一 workspace 内可继续读取 source-session evidence ref；跨 workspace clone 不在本次范围。
- 本次不删除旧 Artifact，不迁移或重写既有 RuntimeEvent。

## 验收

1. 大输出只产生一份 durable Evidence，RuntimeEvent 不包含原始中段正文；
2. 下一次 Provider 请求只见 bounded preview、完整性元数据与 evidence ref；
3. `read_evidence` 可分页精确回读原文，错误 session/hash 被拒绝；
4. Evidence 写入失败时 Provider 收到完整原文，RuntimeEvent 使用 inline raw；
5. 新旧 ToolResult event 混合的 Session 可恢复、rewind、fork 且保持协议配对；
6. 重启后模型投影与提交时一致；
7. 一条真实模型 E2E 能识别 preview，并按 ref 回读原文中的 canary。

## 回滚

回滚代码不会破坏旧 Session；包含新 `tool.result.recorded` 的 Session 需要保留新版 decoder。
因此发布回滚应优先关闭新写入路径、继续读取新旧事件，而不是降级到不认识新 event kind 的二进制。
