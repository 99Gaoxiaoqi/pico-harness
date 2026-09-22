import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiSdkProvider } from "@pico/pico-host/provider/ai-sdk-provider";
import { Session } from "@pico/pico-host/session";
import { resolvePicoPaths } from "@pico/pico-host";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { RuntimeRun } from "@pico/pico-host/product-runtime-run";
import { CostTracker } from "@pico/runtime/cost-tracker";
import { SqliteRuntimeControlStore } from "@pico/storage";
import { querySessionExecution } from "../../packages/pico-host/src/session-execution-query.js";
import { getLatestContextRequest } from "../../packages/pico-host/src/session-context-composition.js";
import { loadUserDefaultRealModel } from "./real-llm-user-model.js";

test(
  "real configured model persists one physical request and matching context/trace",
  { skip: process.env.PICO_PHYSICAL_ACCOUNTING_E2E !== "1", timeout: 130000 },
  async () => {
    const model = await loadUserDefaultRealModel();
    const root = await mkdtemp(join(tmpdir(), "pico-real-accounting-"));
    const picoHome = join(root, "home");
    const session = new Session("real-accounting", root, {
      persistence: true,
      picoHome,
      runtimePort: createEngineRuntimePort(),
    });
    const ledger = new SqliteRuntimeControlStore({
      storageRoot: resolvePicoPaths(root, { picoHome }).workspace.root,
    });
    try {
      await session.recover();
      const tracked = new CostTracker(
        new AiSdkProvider(model.provider, { ...model.config, sessionId: session.id }),
        { provider: model.provider, model: model.config.model, baseUrl: model.config.baseURL },
        session,
        { ledger, context: { purpose: "main", sessionId: session.id } },
      );
      const run = await RuntimeRun.start({
        capability: session.runtimeEventCapability!,
        agentSwarmAuthorization: "none",
      });
      const response = await run.run(() =>
        tracked.generateStream(
          [
            {
              role: "user",
              content:
                "Connectivity verification. Reply exactly PICO_ACCOUNTING_OK. Do not use tools.",
            },
          ],
          [],
          () => {},
          { timeoutMs: 90000, toolChoice: "none" },
        ),
      );
      assert.match(response.content ?? "", /PICO_ACCOUNTING_OK/);
      const attempts = ledger.listPhysicalAttempts({ sessionId: session.id });
      assert.ok(attempts.length >= 1);
      const succeeded = attempts.find((a) => a.status === "succeeded");
      assert.ok(succeeded);
      assert.equal(succeeded.usageBasis, "reported");
      const page = querySessionExecution(ledger.storageRoot, { sessionId: session.id });
      assert.equal(page.summary.physicalAttempts, attempts.length);
      const context = getLatestContextRequest(ledger.storageRoot, session.id);
      assert.equal(context.status, "available");
      assert.equal(context.physicalAttemptId, succeeded.physicalAttemptId);
      console.log(
        JSON.stringify({
          model: model.config.model,
          physicalAttempts: attempts.length,
          inputTokens: page.summary.inputTokens,
          outputTokens: page.summary.outputTokens,
          ttftMs: succeeded.timeToFirstTokenMs,
          httpStatus: succeeded.httpStatus,
          costStatus: succeeded.costStatus,
          contextBytes: context.composition?.totalBytes,
        }),
      );
    } finally {
      await session.close();
      ledger.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
