// 兼容旧的 Engine 导入路径；新代码应从 @pico/runtime 导入投影诊断。
export { isHardDiagnostic, makeDiagnostic, severityFor } from "@pico/runtime";
export type {
  DiagnosticSeverity,
  RuntimeProjectionDiagnostic,
  RuntimeProjectionDiagnosticCode,
} from "@pico/runtime";
