import { describe, expect, it } from "vitest";
import type { SubagentModelCatalog } from "../src/runtime/subagent-model-catalog.js";
import { DelegationManager } from "../src/tools/delegation-manager.js";
import { ToolRegistry } from "../src/tools/registry-impl.js";
import { DelegateTaskTool, type AgentRunner, type SubagentResult } from "../src/tools/subagent.js";

interface ObjectSchema {
  properties: Record<string, unknown>;
}

interface StringSchema {
  enum?: string[];
  description?: string;
}

const runner: AgentRunner = {
  async runSub(): Promise<SubagentResult> {
    return { summary: "ok", artifacts: [] };
  },
};

function schemas(catalog?: SubagentModelCatalog): {
  singleAgent: ObjectSchema;
  batchAgent: ObjectSchema;
  modelRoute: StringSchema;
} {
  const tool = new DelegateTaskTool(runner, () => new ToolRegistry(), new DelegationManager(), {
    ...(catalog ? { modelCatalog: catalog } : {}),
  });
  const root = tool.definition().inputSchema as unknown as ObjectSchema;
  const singleAgent = root.properties.agent as ObjectSchema;
  const tasks = root.properties.tasks as { items: ObjectSchema };
  const batchAgent = tasks.items.properties.agent as ObjectSchema;
  return {
    singleAgent,
    batchAgent,
    modelRoute: singleAgent.properties.model_route as StringSchema,
  };
}

describe("delegate_task 子代理模型目录 Schema", () => {
  it("只枚举 inherit 和前台目录中的规范路由，并披露模型能力与 alias 映射", () => {
    const catalog = {
      parentRouteId: "openai/gpt-5.2",
      allowRouteOverride: true,
      totalSelectableRoutes: 2,
      truncated: false,
      routes: [
        {
          id: "zhipu/glm-5.2",
          model: "glm-5.2",
          aliases: ["review", "glm"],
          reasoning: true,
        },
        {
          id: "deepseek/deepseek-v4-flash",
          model: "deepseek-v4-flash",
          aliases: ["fast"],
          reasoning: "unknown",
        },
      ],
    } satisfies SubagentModelCatalog;

    const { singleAgent, batchAgent, modelRoute } = schemas(catalog);

    expect(modelRoute.enum).toEqual(["inherit", "zhipu/glm-5.2", "deepseek/deepseek-v4-flash"]);
    expect(modelRoute.enum).not.toContain("review");
    expect(modelRoute.enum).not.toContain("fast");
    expect(modelRoute.description).toContain("inherit → openai/gpt-5.2");
    expect(modelRoute.description).toContain(
      "zhipu/glm-5.2: model=glm-5.2; reasoning=supported; aliases=review → zhipu/glm-5.2，glm → zhipu/glm-5.2",
    );
    expect(modelRoute.description).toContain(
      "deepseek/deepseek-v4-flash: model=deepseek-v4-flash; reasoning=unknown; aliases=fast → deepseek/deepseek-v4-flash",
    );
    expect(batchAgent).toBe(singleAgent);
  });

  it("宿主禁止覆盖模型时只允许 inherit 并说明父路由", () => {
    const catalog = {
      parentRouteId: "anthropic/claude-sonnet-4",
      allowRouteOverride: false,
      totalSelectableRoutes: 0,
      truncated: false,
      routes: [],
    } satisfies SubagentModelCatalog;

    const { modelRoute } = schemas(catalog);

    expect(modelRoute.enum).toEqual(["inherit"]);
    expect(modelRoute.description).toContain("只能使用 inherit");
    expect(modelRoute.description).toContain("anthropic/claude-sonnet-4");
  });

  it("目录截断时披露总数、当前数量与完整路由回退方式", () => {
    const catalog = {
      parentRouteId: "openai/gpt-5.2",
      allowRouteOverride: true,
      totalSelectableRoutes: 87,
      truncated: true,
      routes: [
        {
          id: "zhipu/glm-5.2",
          model: "glm-5.2",
          aliases: [],
          reasoning: false,
        },
      ],
    } satisfies SubagentModelCatalog;

    const { modelRoute } = schemas(catalog);

    expect(modelRoute.description).toContain("共 87 条可选路由，当前披露 1 条");
    expect(modelRoute.description).toContain("完整 provider/model 路由");
    expect(modelRoute.description).toContain("reasoning=unsupported");
  });

  it("未注入目录时保留接受宿主已有 route 的兼容 Schema", () => {
    const { modelRoute } = schemas();

    expect(modelRoute.enum).toBeUndefined();
    expect(modelRoute.description).toBe(
      "宿主已有 provider/model 路由或 inherit；不能携带 endpoint/凭证。",
    );
  });
});
