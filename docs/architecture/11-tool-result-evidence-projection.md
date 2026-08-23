# ToolResult 事实、Evidence 与宿主投影

> 文档状态：已被[决策记录 26](./26-decision-tool-result-entry-shaping.md)取代，仅保留设计
> 演进背景。当前新写路径使用 inline ToolResult、1 MiB 入口门和读取侧投影；
> `read_evidence` 已退役，旧 Evidence 形态只在兼容读取边界保留。

## 目标

ToolResult 采用一条不可分叉的主链：

1. 工具返回原始结果；
2. Runtime 写入唯一 canonical 事实 `tool.result.recorded`；
3. 大正文只在 Evidence CAS 保存一份；
4. Provider、Hook、Reporter、TUI 和 Desktop 都从 canonical 事实取得有界投影；
5. 需要原文时用 `read_evidence` 按字节分页回读。

项目处于开发期，本设计是硬切换。旧 Message ToolResult、Runtime ToolResult Evidence v1、
Fork v1/v2/v3/v4、ToolResultArtifactStore、`read_artifact` 和 Artifact UI 不再读取或迁移。

## 唯一持久化不变量

`message.committed.data.message.toolCallId` 永远不存在。带 `toolCallId` 的 `Message` 只是在
Provider、压缩器和 UI 边界上的临时投影；持久层中的 ToolResult 只能是：

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

- `body.sha256/sizeBytes` 始终描述工具原始 UTF-8 输出；
- Evidence 成功后，event 只保留引用和完整性元数据；
- Evidence 写失败时，原文保存在 inline canonical body，但 Provider 和宿主仍使用有界
  projection，不能让大正文重新穿透边界；
- Runtime 的批量 append 与 Session 投影共同完成后，结果才允许发布给 Hook/Reporter。

所有 Runtime 写入口都 fail-closed：未先注册的 Message ToolResult、幂等 Message 写入口中的
ToolResult、旧账本中的 Message ToolResult都会被拒绝，不再降级成普通消息。

## Provider 投影与宿主 Envelope

当前 Turn 不调用模型生成 ToolResult 摘要。`buildRuntimeToolResultProjection` 只做确定性策略：

- 小结果保留 full；
- 大结果生成 tool-aware、head/tail 等确定性 preview；
- 默认阈值按约 2,048 tokens 估算；
- 默认 preview 不超过约 1,600 字符；
- Registry 和 MCP bridge 必须返回完整物理结果，不得提前截断；
- `read_evidence` 自身有分页上限，不再次归档。

Hook、Reporter 和 UI 共用：

```ts
interface ToolResultEnvelope {
  version: 1;
  toolCallId: string;
  toolName: string;
  status: RuntimeToolResultStatus;
  rawSizeBytes: number;
  sha256: string;
  projection: RuntimeToolResultProjection;
  deliveryTruncated: boolean;
  evidence?: {
    uri: string;
    ref: RuntimeEvidenceReference;
  };
}
```

Envelope 不含 raw body。宿主投影另有 UTF-8 16 KiB 上限；二次封顶时
`deliveryTruncated=true`。UI 只有在 `mode=full`、canonical projection 未截断且
`deliveryTruncated=false` 时才把正文标记为完整 inline 结果。

## 写入与发布顺序

```text
tool.execute
  → 获取未截断 raw output
  → 计算 raw sha256 / sizeBytes
  → 生成确定性 full/preview projection
  → 大结果写 Evidence CAS
      ├─ 成功：body=evidence + evidence ref
      └─ 失败：body=inline raw + 保持 bounded projection
  → 注册 tool.result.recorded
  → 原子提交整批 ToolResult
  → 更新 Session projection
  → PostToolUse/PostToolUseFailure（ToolResultEnvelope）
  → Reporter.onToolResult（ToolResultEnvelope）
  → PostToolBatch（Provider 顺序的 ToolResultEnvelope）
```

并发批次的 canonical ToolResult 保持 Provider 顺序；单项 Reporter 展示可保持真实完成顺序。
异常关闭时，已完成与 synthetic cancelled/interrupted 结果都必须各发布一次。

## Evidence

大正文位于 workspace Evidence 根下的 SHA-256 CAS。manifest 按 kind 区分：

- `tool-exchange`：Runtime ToolResult 原文；
- `subagent-report`：超过子代理常规回传预算的完整最终报告。

`read_evidence(ref, offsetBytes?, limitBytes?)` 只接受 `pico://evidence/...`，不接受模型提供的
文件路径。读取必须验证：

- Evidence root、session、manifest 和 blob 的目录/普通文件身份；
- URI 的 canonical session/hash；
- manifest 内容 hash；
- blob SHA-256 与 size；
- UTF-8 offset/limit 边界；
- 单页读取上限。

FullCompactor 不另写 compaction Evidence。被摘要的 RuntimeEvent 与 ToolResult Evidence
仍保持不变；checkpoint 只保存覆盖边界和摘要投影。

## 子代理

子代理看到的每条工具结果同样来自 structured Runtime ToolResult。最终报告本身仍是子代理模型
生成的任务总结；当报告超过常规回传预算时，完整报告写入 `subagent-report` Evidence，主 Agent
只收到确定性预览、Evidence URI 和回读指令。

这里不再写第二份 LLM 摘要，也不再返回 Artifact 路径。`SubagentResult` 和委派聚合只传
`evidenceRefs`。

## Fork、rewind 与恢复

- Fork bundle 只接受 v5 source-sequenced `seedEntries`，联合冻结 active model facts 与完整 durable transcript；v1-v4 直接拒绝，不再重复保存 `messages` 或单独的 `historyEntries` 投影；
- v1-v4 bundle 明确拒绝，不再回落到 Message 导入；
- 同一 workspace 的 fork 继续引用 source-session Evidence URI，不复制或改写 CAS；
- rewind（用户侧 /rewind 命令）内部走 non-destructive fork：旧 Session 不变，新 Session 继承切片后的 tool.result.recorded 与 Evidence URI；
- 未闭合 tool call 的恢复结果仍写 `tool.result.recorded`；
- durable Runtime 禁止使用会把 ToolResult 投影重写为 `message.committed` 的
  `truncateTo/applyInMemoryCompaction` 路径；生产压缩通过 Runtime checkpoint 改变读模型。

## 摘要边界

ToolResult 当前轮不使用 LLM 摘要。LLM 摘要只存在于两个明确边界：

1. 子代理完成任务时生成自己的最终报告；
2. 历史仍超过上下文预算时，由 FullCompactor 生成 checkpoint 摘要。

两者都不能改写已经发生的 ToolResult body、hash、status 或 Evidence。

## 验收

1. 大输出只产生一份 ToolResult Evidence，RuntimeEvent 不含原始中段正文；
2. Provider、Hook 和 Reporter 都看不到 raw canary，只拿 bounded projection/hash/size/ref；
3. `read_evidence` 能分页拼回 tool-exchange 与 subagent-report 原文；
4. Evidence 写失败时 canonical inline body 完整，Provider/宿主仍有界；
5. Message ToolResult、Runtime Evidence v1、Fork v1-v4 和 Artifact 引用明确失败；
6. fork、rewind、崩溃恢复和 hydration 都保持 structured ToolResult 身份；
7. 一条真实模型 E2E 能从 preview 识别 Evidence URI，并回读原文 canary。

## 开发期清理

旧会话不在兼容范围。升级后可删除对应 workspace 下旧 Session、fork staging 和 `artifacts/`
数据；程序不会自动删除用户磁盘数据，也不会尝试迁移或静默跳过旧格式。
