import { AtomicMemoryLifecycle } from "@pico/runtime";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { executeAgentRuntime } from "@pico/pico-host/agent-runtime";
import { createProvider } from "@pico/pico-host/provider/factory";
import { globalSessionManager } from "@pico/pico-host/session";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { resolvePicoHome } from "@pico/pico-host";
import { UserConfigStore } from "@pico/pico-host/input/user-config-store";
import { EffectiveConfigResolver } from "@pico/pico-host/input/effective-config";
import { loadEffectiveModelRuntime } from "@pico/pico-host/provider/effective-model-runtime";
import type { LLMProvider, Message } from "@pico/core";
import { runFailureLearningExperiment } from "./failure-learning.js";

export async function runRealFailureLearningExperiment(directory: string) {
  const userHome = resolvePicoHome();
  const userConfigStore = new UserConfigStore({ picoHome: userHome });
  const runtime = await loadEffectiveModelRuntime({
    workDir: userHome,
    projectTrusted: false,
    env: process.env,
    userConfigStore,
    configResolver: new EffectiveConfigResolver({ userConfigStore }),
  });
  const routeId = runtime.config.defaultModelRouteId;
  if (!routeId || runtime.config.sources["defaults.modelRouteId"] !== "user")
    throw new Error("The experiment requires a user-configured default model route.");
  const configured = runtime.router.providerConfig(routeId);
  if (runtime.config.sources[`providers.${configured.route.providerId}`] !== "user")
    throw new Error("The experiment requires a user-configured provider.");
  const provider = createProvider(configured.provider, configured.config);
  return runFailureLearningExperiment({
    directory,
    model: configured.route.id,
    port: {
      async complete(messages) {
        const response = await provider.generate(messages, [], { timeoutMs: 60_000 });
        if (response.toolCalls?.length) throw new Error("UnexpectedModelTools");
        return response.content;
      },
      async freshSession(input) {
        const trust = new WorkspaceTrustStore({ userStateDirectory: input.picoHome });
        await trust.trust(await trust.canonicalize(input.workDir));
        const lifecycle = new AtomicMemoryLifecycle();
        let memoryDelivered = false;
        let modelCalls = 0;
        const observe = (messages: readonly Message[]) => {
          memoryDelivered ||= messages.some(
            ({ content }) =>
              content.includes('kind="failure"') &&
              content.includes("Experimental lesson for FixtureNorth"),
          );
        };
        const tracked = new Proxy(provider, {
          get(target, key) {
            if (key === "generate")
              return (...args: Parameters<LLMProvider["generate"]>) => {
                modelCalls++;
                observe(args[0]);
                return target.generate(...args);
              };
            if (key === "generateStream" && target.generateStream)
              return (...args: Parameters<NonNullable<LLMProvider["generateStream"]>>) => {
                modelCalls++;
                observe(args[0]);
                return target.generateStream!(...args);
              };
            const value: unknown = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        try {
          const result = await executeAgentRuntime(
            {
              prompt: input.prompt,
              dir: input.workDir,
              sessionSelection: { mode: "new", sessionId: input.sessionId },
              provider: configured.provider,
              modelRouteId: configured.route.id,
              baseURL: configured.config.baseURL,
              apiKey: configured.config.apiKey,
              model: configured.config.model,
              modelCapabilities: configured.route.capabilities,
              allowedTools: [],
            },
            {
              picoHome: input.picoHome,
              modelRouter: runtime.router,
              provider: tracked,
              reporter: new SilentReporter(),
              memoryTrustStore: trust,
              atomicMemoryLifecycle: lifecycle,
              maxTurns: 2,
              atomicMemoryModelFactory: async () => {
                throw new Error("UnexpectedAutomaticExtraction");
              },
            },
          );
          return { content: result.finalMessage, memoryDelivered, modelCalls };
        } finally {
          await lifecycle.close();
          await globalSessionManager
            .delete(input.sessionId, input.workDir, { picoHome: input.picoHome })
            ?.close();
        }
      },
    },
  });
}
