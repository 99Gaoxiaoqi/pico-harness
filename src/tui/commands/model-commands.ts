import { type RuntimeEffectiveConfig } from "@pico/protocol";
import type { ClientCommandRegistryDeps } from "./types.js";
import { rpcCommand, sessionAccess } from "./shared.js";

export function createModelCommands(deps: ClientCommandRegistryDeps) {
  const { runtime, workspacePath } = deps;
  const { needSession } = sessionAccess(runtime);
  return {
    model: rpcCommand({
      name: "model",
      aliases: ["models"],
      description: "查看或切换模型路由",
      usage: "/model [name]",
      argumentHint: "[name]",
      category: "model",
      availability: "idle",
      execute: async (input) => {
        // config.effective.get 将配置放在 result.config 中。
        const { config: configured } = await runtime.request("config.effective.get", {
          workspacePath,
        });
        const routes = modelRoutesFromConfig(configured);
        const target = input.argv[0];
        if (target === undefined) {
          return {
            type: "local",
            action: "model",
            ui: { kind: "open-selector", selector: "model" },
            data: { modelRoutes: routes },
            message: `当前默认路由：${configured.defaultModelRouteId ?? "(未设置)"}`,
          };
        }
        const exact = routes.find((route) => route.id === target);
        const candidates = routes.filter((route) => route.name === target);
        if (!exact && candidates.length > 1) {
          return {
            type: "local",
            action: "model",
            ui: { kind: "open-selector", selector: "model" },
            data: { modelRoutes: candidates },
            message: `多个厂商提供 ${target}，请选择厂商，或使用完整路由：${candidates.map((route) => `/model ${route.id}`).join("、")}。`,
          };
        }
        const matched = exact ?? candidates[0];
        if (!matched) {
          return {
            type: "local",
            action: "message",
            message: `未知模型路由 ${target}。可用：${routes.map((route) => route.id).join("、") || "(无)"}。`,
          };
        }
        const sid = needSession();
        if (typeof sid === "object") return sid;
        const updated = await runtime.request("session.settings.update", {
          workspacePath,
          sessionId: sid,
          modelRouteId: matched.id,
        });
        return {
          type: "local",
          action: "model",
          message: `模型路由已切换：${updated.settings.modelRouteId ?? matched.id}`,
        };
      },
    }),
    thinking: rpcCommand({
      name: "thinking",
      aliases: ["effort"],
      description: "查看或设置思考强度",
      usage: "/thinking [level]",
      argumentHint: "[model level]",
      category: "model",
      availability: "idle",
      execute: async (input) => {
        const sid = needSession();
        if (typeof sid === "object") return sid;
        const current = await runtime.request("session.settings.get", {
          workspacePath,
          sessionId: sid,
        });
        const levels = current.settings.reasoningLevels ?? [];
        const target = input.argv[0];
        if (target === undefined) {
          return {
            type: "local",
            action: "thinking",
            message: `当前思考强度：${current.settings.thinkingEffort ?? "(默认)"}。可选：${levels.join("、") || "(跟随模型)"}。`,
          };
        }
        if (levels.length > 0 && !levels.includes(target)) {
          return {
            type: "local",
            action: "message",
            message: `未知思考强度 ${target}。可选：${levels.join("、")}。`,
          };
        }
        const updated = await runtime.request("session.settings.update", {
          workspacePath,
          sessionId: sid,
          thinkingEffort: target,
        });
        return {
          type: "local",
          action: "thinking",
          message: `思考强度已设置：${updated.settings.thinkingEffort ?? target}`,
        };
      },
    }),
    provider: rpcCommand({
      name: "provider",
      description: "Manage shared user providers without exposing credentials in command arguments",
      usage:
        "/provider [list | import-env <id> [--confirm] | default <provider/model|clear> | delete <id>]",
      argumentHint: "[list | import-env | default | delete]",
      category: "model",
      availability: "idle",
      execute: async (input) => {
        const msg = (text: string) => ({
          type: "local" as const,
          action: "message" as const,
          message: text,
        });
        const [subcommand = "list", first, confirmation, ...rest] = input.argv;
        if (rest.length > 0) {
          return msg(
            "Usage: /provider [list | import-env <id> [--confirm] | default <provider/model|clear> | delete <id>]",
          );
        }
        try {
          if (subcommand === "list" && first === undefined && confirmation === undefined) {
            const [listed, effective] = await Promise.all([
              runtime.request("provider.list", {}),
              runtime.request("config.effective.get", { workspacePath }),
            ]);
            if (listed.providers.length === 0) {
              return msg(
                "No providers configured. Set complete LLM_* variables, then run /provider import-env <id> to preview an import.",
              );
            }
            const defaultRoute = effective.config.defaultModelRouteId ?? "";
            return msg(
              listed.providers
                .map(
                  (provider) =>
                    `${provider.id} · ${provider.protocol} · ${provider.origin} · credential=${provider.credentialStatus}${defaultRoute.startsWith(`${provider.id}/`) ? " · default" : ""}\n  ${provider.baseURL}\n  models: ${provider.models.join(", ") || "discovery"}`,
                )
                .join("\n"),
            );
          }
          if (subcommand === "import-env") {
            if (!first || (confirmation !== undefined && confirmation !== "--confirm")) {
              return msg("Usage: /provider import-env <id> [--confirm]");
            }
            const baseURL = process.env.LLM_BASE_URL?.trim();
            const defaultModel = process.env.LLM_MODEL?.trim();
            const secret =
              process.env.LLM_API_KEYS?.trim() || process.env.LLM_API_KEY?.trim() || "";
            const apiKeyEnv = process.env.LLM_API_KEYS?.trim() ? "LLM_API_KEYS" : "LLM_API_KEY";
            if (!baseURL || !defaultModel || !secret) {
              return msg(
                "Import unavailable: LLM_BASE_URL, LLM_MODEL and LLM_API_KEY[S] must all be set in this process.",
              );
            }
            if (!/^[^/\s]+$/u.test(first)) {
              return msg("Provider ID cannot contain whitespace or slash.");
            }
            const models = [
              ...new Set(
                [defaultModel, ...(process.env.LLM_MODELS?.split(/[\s,]+/u) ?? [])].filter(Boolean),
              ),
            ];
            const normalizedEndpoint = baseURL.replace(/\/+$/u, "");
            if (confirmation !== "--confirm") {
              return msg(
                [
                  `Import preview for ${first}:`,
                  "protocol: openai",
                  `endpoint: ${normalizedEndpoint}`,
                  `models: ${models.join(", ")}`,
                  "credential: current process environment -> OS credential vault (value hidden)",
                  `Confirm with: /provider import-env ${first} --confirm`,
                ].join("\n"),
              );
            }
            const listed = await runtime.request("provider.list", {});
            const result = await runtime.request("provider.importEnvironment", {
              provider: {
                id: first,
                protocol: "openai",
                baseURL: normalizedEndpoint,
                apiKeyEnv,
                models,
                discoverModels: true,
              },
              defaultModel,
              secret,
              expectedRevision: listed.revision,
            });
            return msg(
              `Provider imported: ${result.provider.id}（credential 已入 OS 凭据库，值不回显）。`,
            );
          }
          if (subcommand === "default" && first && confirmation === undefined) {
            if (first === "clear" || first === "none") {
              return msg("暂不支持经客户端清除默认路由；请直接编辑 daemon 用户配置。");
            }
            const current = await runtime.request("config.user.get", {});
            await runtime.request("config.user.update", {
              defaults: { ...current.config.defaults, modelRouteId: first },
              expectedRevision: current.revision,
            });
            return msg(`默认模型路由已设置：${first}。`);
          }
          if (subcommand === "delete" && first && confirmation === undefined) {
            const listed = await runtime.request("provider.list", {});
            await runtime.request("provider.delete", {
              providerId: first,
              expectedRevision: listed.revision,
            });
            return msg(`Provider deleted: ${first}。`);
          }
          return msg(
            "Usage: /provider [list | import-env <id> [--confirm] | default <provider/model|clear> | delete <id>]",
          );
        } catch (error) {
          return msg(
            `Provider command failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    }),
  };
}

function modelRoutesFromConfig(config: RuntimeEffectiveConfig): {
  id: string;
  name: string;
}[] {
  const routes: { id: string; name: string }[] = [];
  const providers = (Array.isArray(config.providers) ? config.providers : []) as readonly Record<
    string,
    unknown
  >[];
  for (const provider of providers) {
    const providerId = typeof provider["id"] === "string" ? provider["id"] : undefined;
    const models = Array.isArray(provider["models"]) ? provider["models"] : [];
    if (!providerId) continue;
    for (const model of models) {
      if (typeof model === "string") {
        routes.push({ id: `${providerId}/${model}`, name: model });
      }
    }
  }
  return routes;
}
