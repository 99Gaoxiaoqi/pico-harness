import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgentFromCli } from "../../src/cli/run-agent.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import { FTS5Store } from "../../src/memory/fts5-store.js";
import { startFakeOpenAiServer } from "../../scripts/fake-openai-server.mjs";

describe("local OpenAI-compatible end-to-end lane", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    FTS5Store.closeAll();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("runs the assembled agent against a local SSE endpoint without credentials or internet", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-local-openai-e2e-"));
    const fakeServer = await startFakeOpenAiServer({ content: "PICO_LOCAL_OPENAI_OK" });
    cleanups.push(() => rm(workDir, { recursive: true, force: true }));
    cleanups.push(() => fakeServer.close());

    const result = await runAgentFromCli(
      {
        prompt: "Reply exactly PICO_LOCAL_OPENAI_OK. Do not use tools.",
        dir: workDir,
        session: `local-openai-${Date.now()}`,
        provider: "openai",
        model: "fake-model",
        thinkingEffort: "off",
      },
      {
        reporter: new SilentReporter(),
        env: {
          LLM_BASE_URL: fakeServer.baseURL,
          LLM_API_KEY: "local-test-key",
          LLM_MODEL: "fake-model",
          PICO_PERSISTENCE: "0",
        },
      },
    );

    expect(result.finalMessage).toContain("PICO_LOCAL_OPENAI_OK");
    expect(fakeServer.requestCount).toBeGreaterThan(0);
  });
});
