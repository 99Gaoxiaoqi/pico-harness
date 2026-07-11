import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgentFromCli } from "../../src/cli/run-agent.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import { globalSessionManager } from "../../src/engine/session.js";
import { FTS5Store } from "../../src/memory/fts5-store.js";
import { createRawProvider } from "../../src/provider/factory.js";
import { ModelCapabilityError } from "../../src/provider/errors.js";
import { loadModelRouter } from "../../src/provider/model-router.js";
import { ModelRuntimeCommandService } from "../../src/provider/model-runtime-report.js";
import { loadPicoConfig } from "../../src/input/pico-config.js";
import { estimateCost } from "../../src/observability/pricing.js";

describe("stage 12 model capabilities integration", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    globalSessionManager.clear();
    FTS5Store.closeAll();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("loads route metadata, rejects unsupported input before HTTP, and reports real session usage", async () => {
    const endpoint = await startOpenAiServer();
    cleanups.push(endpoint.close);
    const workDir = await mkdtemp(join(tmpdir(), "pico-stage12-model-"));
    cleanups.push(() => rm(workDir, { recursive: true, force: true }));
    await mkdir(join(workDir, ".pico"), { recursive: true });
    await writeFile(
      join(workDir, ".pico", "config.json"),
      JSON.stringify({
        version: 1,
        model: "local/capable-model",
        providers: {
          local: {
            protocol: "openai",
            baseURL: endpoint.baseURL,
            apiKeyEnv: "LOCAL_API_KEY",
            discoverModels: false,
            models: {
              "capable-model": {
                context: 8192,
                output: 1024,
                vision: false,
                reasoning: false,
                toolCall: true,
                cache: false,
                fallback: false,
                price: {
                  inputPerMillion: 1,
                  outputPerMillion: 2,
                  cacheReadPerMillion: 0.1,
                  cacheWritePerMillion: 1,
                },
              },
            },
          },
        },
      }),
    );

    const config = await loadPicoConfig(workDir);
    const router = await loadModelRouter({
      config,
      env: { LOCAL_API_KEY: "secret" },
      legacyProvider: "openai",
      legacyModel: "unused",
    });
    const active = router.providerConfig(config.model, "off");
    expect(active.route.capabilities.vision).toBe(false);
    expect(active.route.capabilities.price.source).toBe("config");

    const raw = createRawProvider(active.provider, active.config);
    await expect(
      raw.generate(
        [
          {
            role: "user",
            content: "inspect",
            images: [{ type: "image_base64", mimeType: "image/png", data: "AA==" }],
          },
        ],
        [],
      ),
    ).rejects.toBeInstanceOf(ModelCapabilityError);
    expect(endpoint.requestCount).toBe(0);

    const sessionId = `stage12-model-${Date.now()}`;
    const result = await runAgentFromCli(
      {
        prompt: "answer once",
        dir: workDir,
        session: sessionId,
        provider: active.provider,
        baseURL: active.config.baseURL,
        apiKey: active.config.apiKey,
        model: active.config.model,
        modelRouteId: active.route.id,
        modelCapabilities: active.route.capabilities,
        allowModelFallback: false,
        thinkingEffort: "off",
      },
      { env: { PICO_PERSISTENCE: "0" }, reporter: new SilentReporter() },
    );
    expect(endpoint.requestCount).toBe(1);

    const session = globalSessionManager.get(sessionId, result.workDir);
    expect(session).toBeDefined();
    const service = new ModelRuntimeCommandService(active.route, session!);
    const usage = service.usage();
    expect(usage.fields.promptTokens).toMatchObject({ value: 12, status: "reported" });
    expect(usage.fields.cacheReadTokens).toMatchObject({ value: null, status: "unknown" });
    expect(usage.cost).toMatchObject({ status: "estimated", priceSource: "config" });
    expect(service.context()).toMatchObject({
      routeId: "local/capable-model",
      contextWindowTokens: 8192,
      estimation: "estimated",
    });
    expect(
      estimateCost(
        {
          provider: "local",
          model: "partial-price-model",
          pricing: {
            inputPerMillion: 1,
            outputPerMillion: null,
            cacheReadPerMillion: null,
            cacheWritePerMillion: null,
            source: "configured",
          },
        },
        { promptTokens: 10, completionTokens: 2 },
      ),
    ).toMatchObject({ status: "unknown", costCNY: 0 });
  });
});

async function startOpenAiServer(): Promise<{
  baseURL: string;
  readonly requestCount: number;
  close: () => Promise<void>;
}> {
  const state = { requestCount: 0 };
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    state.requestCount++;
    await readJsonBody(request);
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "DONE" } }] })}\n\n`);
    response.write(
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server failed to bind");
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    get requestCount() {
      return state.requestCount;
    },
    close: () => close(server),
  };
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
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
