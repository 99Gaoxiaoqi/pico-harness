import { describe, expect, it } from "vitest";
import { resolveModelRouteCapabilities } from "../src/provider/model-capabilities.js";
import { ModelRouter, type ModelRoute } from "../src/provider/model-router.js";
import {
  buildSubagentModelCatalog,
  createInheritOnlySubagentModelCatalog,
} from "../src/runtime/subagent-model-catalog.js";

describe("子代理模型目录集成", () => {
  it("只投影有效路由并脱敏、深冻结结果", () => {
    const parent = route("parent/main", "main", "config", "PARENT_KEY", true);
    const unavailable = route("private/secret", "secret", "config", "MISSING_KEY", false);
    const router = new ModelRouter(
      [parent, unavailable],
      { PARENT_KEY: "parent-secret" },
      parent.id,
    );

    const catalog = buildSubagentModelCatalog({
      router,
      parentRouteId: parent.id,
      aliases: { review: parent.id, hidden: unavailable.id },
      allowRouteOverride: true,
    });

    expect(catalog).toEqual({
      routes: [
        {
          id: parent.id,
          model: parent.model,
          aliases: ["review"],
          reasoning: true,
        },
      ],
      parentRouteId: parent.id,
      allowRouteOverride: true,
      totalSelectableRoutes: 1,
      truncated: false,
    });
    expect(JSON.stringify(catalog)).not.toContain("parent-secret");
    expect(JSON.stringify(catalog)).not.toContain(parent.baseURL);
    expect(JSON.stringify(catalog)).not.toContain(parent.apiKeyEnv);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.routes)).toBe(true);
    expect(Object.isFrozen(catalog.routes[0])).toBe(true);
    expect(Object.isFrozen(catalog.routes[0]!.aliases)).toBe(true);
  });

  it("按父路由、别名目标、配置或 legacy、discovered 稳定排序并反向映射别名", () => {
    const discovered = route("z/discovered", "discovered", "discovered", "SHARED_KEY");
    const config = route("c/config", "config", "config", "SHARED_KEY");
    const aliasTarget = route("y/alias", "alias", "discovered", "SHARED_KEY");
    const parent = route("p/parent", "parent", "discovered", "SHARED_KEY");
    const legacy = route("a/legacy", "legacy", "legacy", "SHARED_KEY");
    const router = new ModelRouter(
      [discovered, config, aliasTarget, parent, legacy],
      { SHARED_KEY: "secret" },
      parent.id,
    );

    const catalog = buildSubagentModelCatalog({
      router,
      parentRouteId: parent.id,
      aliases: {
        Z_REVIEW: aliasTarget.id,
        alpha: aliasTarget.model,
        invalid: "missing/model",
      },
      allowRouteOverride: true,
    });

    expect(catalog.routes.map((item) => item.id)).toEqual([
      parent.id,
      aliasTarget.id,
      legacy.id,
      config.id,
      discovered.id,
    ]);
    expect(catalog.routes[1]!.aliases).toEqual(["alpha", "z_review"]);
  });

  it("截断时保留截断前可选总数", () => {
    const routes = Array.from({ length: 70 }, (_, index) =>
      route(`provider/model-${String(index).padStart(2, "0")}`, `model-${index}`, "config", "KEY"),
    );
    const router = new ModelRouter(routes, { KEY: "secret" }, routes[0]!.id);

    const defaultCatalog = buildSubagentModelCatalog({
      router,
      parentRouteId: routes[0]!.id,
      allowRouteOverride: true,
    });
    const smallerCatalog = buildSubagentModelCatalog({
      router,
      parentRouteId: routes[0]!.id,
      allowRouteOverride: true,
      maxRoutes: 2,
    });

    expect(defaultCatalog.routes).toHaveLength(64);
    expect(defaultCatalog.totalSelectableRoutes).toBe(70);
    expect(defaultCatalog.truncated).toBe(true);
    expect(smallerCatalog.routes.map((item) => item.id)).toEqual([routes[0]!.id, routes[1]!.id]);
    expect(smallerCatalog.totalSelectableRoutes).toBe(70);
    expect(smallerCatalog.truncated).toBe(true);
  });

  it("后台禁止 route override 时只公开可用父路由", () => {
    const parent = route("provider/parent", "parent", "config", "KEY");
    const child = route("provider/child", "child", "config", "KEY");
    const router = new ModelRouter([child, parent], { KEY: "secret" }, parent.id);

    const catalog = buildSubagentModelCatalog({
      router,
      parentRouteId: parent.id,
      aliases: { review: child.id },
      allowRouteOverride: false,
    });

    expect(catalog.routes.map((item) => item.id)).toEqual([parent.id]);
    expect(catalog.routes[0]!.aliases).toEqual([]);
    expect(catalog.totalSelectableRoutes).toBe(1);
    expect(catalog.truncated).toBe(false);
  });

  it("没有完整路由器时创建深冻结的 inherit-only 目录", () => {
    const catalog = createInheritOnlySubagentModelCatalog("fixed/provider-model");

    expect(catalog).toEqual({
      routes: [],
      parentRouteId: "fixed/provider-model",
      allowRouteOverride: false,
      totalSelectableRoutes: 0,
      truncated: false,
    });
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.routes)).toBe(true);
  });
});

function route(
  id: string,
  model: string,
  source: ModelRoute["source"],
  apiKeyEnv: string,
  reasoning = false,
): ModelRoute {
  return {
    id,
    providerId: id.split("/")[0]!,
    provider: "openai",
    model,
    baseURL: "https://sensitive.example.test/v1",
    apiKeyEnv,
    source,
    capabilities: resolveModelRouteCapabilities("openai", model, { reasoning }),
  };
}
