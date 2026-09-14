// 子代理上下文策略已迁入 @pico/runtime；保留旧 Engine 路径的兼容导出。
export {
  buildSubagentEvidenceSnapshot,
  compactSubagentContext,
  generateSubagentResponse,
} from "@pico/runtime/subagent-context";
export type {
  SubagentContextDiagnostics,
  SubagentResponseRuntime,
  SubagentUsageSession,
} from "@pico/runtime/subagent-context";
