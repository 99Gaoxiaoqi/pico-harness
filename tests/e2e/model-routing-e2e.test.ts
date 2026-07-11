import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgentFromCli } from "../../src/cli/run-agent.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import { createPicoCommandRegistry } from "../../src/input/pico-command-registry.js";
import { loadPicoConfig } from "../../src/input/pico-config.js";
import { processUserInput } from "../../src/input/process-user-input.js";
import {
  coordinateSessionReasoningLevel,
  getStoredSessionSettings,
  resetSessionSettingsForTests,
} from "../../src/input/session-settings.js";
import { FTS5Store } from "../../src/memory/fts5-store.js";
import { loadModelRouter } from "../../src/provider/model-router.js";

describe("model routing integration", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    resetSessionSettingsForTests();
    FTS5Store.closeAll();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("discovers configured providers, validates /model locally, and runs the selected route", async () => {
    const deepseek = await startOpenAiServer(
      ["deepseek-v4-pro", "deepseek-v4-flash", "server-only-model"],
      "DEEPSEEK_RESPONSE",
    );
    const glm = await startOpenAiServer(["glm-5.2"], "ROUTED_TO_GLM");
    cleanups.push(deepseek.close, glm.close);

    const workDir = await mkdtemp(join(tmpdir(), "pico-model-routing-"));
    cleanups.push(() => rm(workDir, { recursive: true, force: true }));
    await mkdir(join(workDir, ".pico"), { recursive: true });
    await writeFile(
      join(workDir, ".pico", "config.json"),
      JSON.stringify({
        version: 1,
        model: "deepseek/deepseek-v4-pro",
        providers: {
          deepseek: {
            protocol: "openai",
            baseURL: deepseek.baseURL,
            apiKeyEnv: "DEEPSEEK_API_KEY",
            models: ["deepseek-v4-pro", "deepseek-v4-flash"],
          },
          zhipu: {
            protocol: "openai",
            baseURL: glm.baseURL,
            apiKeyEnv: "ZHIPU_API_KEY",
          },
        },
      }),
    );

    const config = await loadPicoConfig(workDir);
    const env = {
      DEEPSEEK_API_KEY: "deepseek-secret",
      ZHIPU_API_KEY: "zhipu-secret",
      PICO_PERSISTENCE: "0",
    };
    const router = await loadModelRouter({
      config,
      env,
      legacyProvider: "openai",
      legacyModel: "unused-protocol-default",
    });

    expect(router.routes.map((route) => route.id)).toEqual([
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4-flash",
      "zhipu/glm-5.2",
    ]);
    expect(deepseek.authorization).toBe("Bearer deepseek-secret");
    expect(glm.authorization).toBe("Bearer zhipu-secret");

    const initial = router.require(config.model);
    const sessionId = `model-route-${Date.now()}`;
    const registry = await createPicoCommandRegistry({
      workDir,
      sessionId,
      provider: initial.provider,
      model: initial.model,
      modelRouteId: initial.id,
      modelRouter: router,
    });

    const rejected = await processUserInput("/model deepseek/glm-5.2", { registry });
    expect(rejected.type === "local-command" ? rejected.result.message : "").toContain("不可用");
    expect(getStoredSessionSettings(sessionId)?.modelRouteId).toBe("deepseek/deepseek-v4-pro");

    const selected = await processUserInput("/model zhipu/glm-5.2", { registry });
    expect(selected.type === "local-command" ? selected.result.message : "").toContain(
      "Model set to zhipu/glm-5.2",
    );
    const settings = getStoredSessionSettings(sessionId)!;
    const active = router.providerConfig(settings.modelRouteId, "off");

    const result = await runAgentFromCli(
      {
        prompt: "route this request",
        dir: workDir,
        session: sessionId,
        provider: active.provider,
        baseURL: active.config.baseURL,
        apiKey: active.config.apiKey,
        model: active.config.model,
        thinkingEffort: "off",
        allowModelFallback: false,
      },
      { env, reporter: new SilentReporter() },
    );

    expect(result.finalMessage).toBe("ROUTED_TO_GLM");
    expect(glm.chatModels).toEqual(["glm-5.2"]);
    expect(deepseek.chatModels).toEqual([]);
  });

  it("coordinates model-specific reasoning levels and maps them to provider request bodies", async () => {
    const server = await startOpenAiServer(
      ["glm-5-2-260617", "deepseek-v4-pro-260425"],
      "REASONING_ROUTE_OK",
    );
    cleanups.push(server.close);

    const workDir = await mkdtemp(join(tmpdir(), "pico-model-reasoning-"));
    cleanups.push(() => rm(workDir, { recursive: true, force: true }));
    await mkdir(join(workDir, ".pico"), { recursive: true });
    await writeFile(
      join(workDir, ".pico", "config.json"),
      JSON.stringify({
        version: 1,
        model: "volcengine/glm-5-2-260617",
        providers: {
          volcengine: {
            protocol: "openai",
            baseURL: server.baseURL,
            apiKeyEnv: "VOLCENGINE_API_KEY",
            discoverModels: false,
            models: {
              "glm-5-2-260617": {
                context: 128000,
                output: 4096,
                reasoning: true,
                toolCall: true,
              },
              "deepseek-v4-pro-260425": {
                context: 128000,
                output: 4096,
                reasoning: true,
                toolCall: true,
              },
            },
          },
        },
      }),
    );

    const env = { VOLCENGINE_API_KEY: "ark-secret", PICO_PERSISTENCE: "0" };
    const config = await loadPicoConfig(workDir);
    const router = await loadModelRouter({
      config,
      env,
      legacyProvider: "openai",
      legacyModel: "unused-protocol-default",
    });
    const initial = router.require(config.model);
    const sessionId = `model-reasoning-${Date.now()}`;
    const registry = await createPicoCommandRegistry({
      workDir,
      sessionId,
      provider: initial.provider,
      model: initial.model,
      modelRouteId: initial.id,
      modelRouter: router,
    });
    const settings = getStoredSessionSettings(sessionId)!;

    expect(coordinateSessionReasoningLevel(settings, router)).toBe("max");
    const status = await processUserInput("/thinking", { registry });
    const statusMessage = status.type === "local-command" ? status.result.message : "";
    expect(statusMessage).toContain("Supported levels: nothink, high, max");
    expect(statusMessage).toContain("Default level: max");
    expect(statusMessage).toContain("Current level: max");

    await processUserInput("/thinking high", { registry });
    await runActiveRoute("glm high", settings, router, workDir, env, sessionId);
    const glmHighBody = server.chatBodies.at(-1)!;
    expect(glmHighBody["model"]).toBe("glm-5-2-260617");
    expect(glmHighBody["reasoning_effort"]).toBeUndefined();
    expect(glmHighBody["chat_template_kwargs"]).toEqual({
      enable_thinking: true,
      reasoning_effort: "high",
    });

    const selectedDeepSeek = await processUserInput("/model volcengine/deepseek-v4-pro-260425", {
      registry,
    });
    expect(
      selectedDeepSeek.type === "local-command" ? selectedDeepSeek.result.message : "",
    ).toContain("Model set to volcengine/deepseek-v4-pro-260425");
    expect(settings.thinkingEffort).toBe("high");

    await processUserInput("/thinking off", { registry });
    await runActiveRoute("deepseek off", settings, router, workDir, env, sessionId);
    const deepSeekOffBody = server.chatBodies.at(-1)!;
    expect(deepSeekOffBody["model"]).toBe("deepseek-v4-pro-260425");
    expect(deepSeekOffBody["thinking"]).toEqual({ type: "disabled" });
    expect(deepSeekOffBody["reasoning_effort"]).toBeUndefined();

    const selectedGlm = await processUserInput("/model volcengine/glm-5-2-260617", {
      registry,
    });
    expect(selectedGlm.type === "local-command" ? selectedGlm.result.message : "").toContain(
      "Thinking level off is unsupported; using model default max.",
    );
    expect(settings.thinkingEffort).toBe("max");
    await runActiveRoute("glm fallback max", settings, router, workDir, env, sessionId);
    expect(server.chatBodies.at(-1)?.["chat_template_kwargs"]).toEqual({
      enable_thinking: true,
      reasoning_effort: "max",
    });
  });
});

async function runActiveRoute(
  prompt: string,
  settings: NonNullable<ReturnType<typeof getStoredSessionSettings>>,
  router: Awaited<ReturnType<typeof loadModelRouter>>,
  workDir: string,
  env: Readonly<Record<string, string>>,
  sessionId: string,
): Promise<void> {
  const active = router.providerConfig(settings.modelRouteId, settings.thinkingEffort);
  await runAgentFromCli(
    {
      prompt,
      dir: workDir,
      session: sessionId,
      provider: active.provider,
      baseURL: active.config.baseURL,
      apiKey: active.config.apiKey,
      model: active.config.model,
      modelRouteId: active.route.id,
      modelCapabilities: active.route.capabilities,
      thinkingEffort: settings.thinkingEffort,
      allowModelFallback: false,
    },
    { env, reporter: new SilentReporter() },
  );
}

async function startOpenAiServer(
  models: string[],
  content: string,
): Promise<{
  baseURL: string;
  authorization?: string;
  chatModels: readonly string[];
  chatBodies: readonly Record<string, unknown>[];
  close: () => Promise<void>;
}> {
  const state: {
    authorization?: string;
    chatModels: string[];
    chatBodies: Record<string, unknown>[];
  } = { chatModels: [], chatBodies: [] };
  const server = createServer(async (request, response) => {
    state.authorization = request.headers.authorization;
    if (request.method === "GET" && request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      const body = await readJsonBody(request);
      state.chatBodies.push(body);
      if (typeof body["model"] === "string") state.chatModels.push(body["model"]);
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 3 },
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
      return;
    }
    response.writeHead(404).end();
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("models server failed to bind");
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    get authorization() {
      return state.authorization;
    },
    get chatModels() {
      return state.chatModels;
    },
    get chatBodies() {
      return state.chatBodies;
    },
    close: () => close(server),
  };
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
