/**
 * 子代理模型目录是 ModelRouter 面向 Agent 工具层的脱敏、会话级只读投影。
 * 它只公开稳定选择标识与模型能力，不包含 endpoint、凭证引用或密钥状态。
 */
export interface SubagentModelCatalogRoute {
  readonly id: string;
  readonly model: string;
  readonly aliases: readonly string[];
  readonly reasoning: boolean | "unknown";
}

export interface SubagentModelCatalog {
  readonly routes: readonly SubagentModelCatalogRoute[];
  readonly parentRouteId: string;
  readonly allowRouteOverride: boolean;
  readonly totalSelectableRoutes: number;
  readonly truncated: boolean;
}
