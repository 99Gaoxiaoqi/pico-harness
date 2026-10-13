import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExperienceUse } from "@pico/core";
import type { RuntimeEvent } from "@pico/storage/runtime-event";
import type { PhysicalAttemptRecord } from "@pico/storage/runtime-control-types";
import { SqliteRuntimeControlStore } from "@pico/storage/sqlite/sqlite-runtime-control-store";
import { SqliteRuntimeEventStore } from "@pico/pico-host/product-runtime-event-store";
import { resolvePicoPaths } from "../../../packages/pico-host/src/pico-paths.js";
import {
  hasConfirmedExperienceDelivery,
  projectExperienceDelivery,
} from "../../../packages/pico-host/src/experience-delivery-evidence.js";

test("历史携带精准匹配原生HTTP与片段证据，未知只改变读投影并保留独立结果", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pico-delivery-history-")));
  const options = { picoHome: join(root, "home"), workDir: join(root, "workspace") };
  mkdirSync(options.workDir);
  const paths = resolvePicoPaths(options.workDir, { picoHome: options.picoHome });
  const events = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
  const ledger = new SqliteRuntimeControlStore({ storageRoot: paths.workspace.root });
  const at = "2026-10-13T00:00:00.000Z";
  const referenceContent = "<memory>方法与适用条件</memory>";
  const referenceHash = createHash("sha256").update(referenceContent).digest("hex");
  try {
    await events.initializeSession({ sessionId: "session", workDir: options.workDir });
    const fence = await events.advanceOwnerFence("session", 0);
    const ownerId = ledger.beginPhysicalAttemptOwner();
    for (const [index, status, httpStatus] of [
      [0, "prepared", undefined],
      [1, "cancelled", undefined],
      [2, "failed", 503],
      [3, "succeeded", 200],
      [4, "cancelled", 200],
    ] as const) {
      const runId = `run-${index}`;
      const providerCallId = `call-${index}`;
      const physicalAttemptId = `physical-${index}`;
      const base = {
        schemaVersion: 2 as const,
        sessionId: "session",
        invocationId: `inv-${index}`,
        runId,
        turnId: `turn-${index}`,
        at,
        partial: false,
        visibility: "internal" as const,
      };
      const journal: RuntimeEvent[] = [
        {
          ...base,
          eventId: `open-${index}`,
          kind: "run.started",
          data: { workDir: options.workDir, agentSwarmAuthorization: "none" },
        },
        {
          ...base,
          eventId: `model-${index}`,
          kind: "model.call.started",
          data: {
            providerCallId,
            provider: "fixture",
            model: "fixture",
            purpose: "main",
            recallEventIds: [`recall-${index}`],
          },
        },
      ];
      await events.appendBatch(journal, { ownerFence: fence });
      const entry = await events.readSessionEvent("session", `model-${index}`);
      assert.ok(entry);
      const use: ExperienceUse = {
        useId: `use-${index}`,
        workspaceKey: paths.workspace.id,
        source: { kind: "reviewed-reference", candidateId: "candidate", contentVersion: 1 },
        itemId: "item",
        itemVersion: 1,
        contentHash: referenceHash,
        taskId: "task",
        taskVersion: 1,
        sessionId: "session",
        runId,
        hostRunId: `host-${index}`,
        recallEventId: `recall-${index}`,
        recallSequence: entry.sequence - 1,
        referenceHash,
        referenceContent,
        delivery: "carried",
        deliverySequence: entry.sequence,
        providerCallId,
        physicalAttemptId,
        historical: false,
        managementRevision: 1,
        settingsVersion: 1,
        deletionRevision: 0,
        adoption: "observed",
        validation: "pass",
        validationScope: "spreadsheet-range",
        excluded: false,
        deleted: false,
        sources: [],
        createdAt: 1,
        updatedAt: 1,
      };
      const record: PhysicalAttemptRecord = {
        accountingVersion: 1,
        accountingSource: "physical",
        physicalAttemptId,
        providerCallId,
        logicalCallId: `logical-${index}`,
        ownerId,
        sessionId: "session",
        runId: use.hostRunId,
        purpose: "main",
        retryAttempt: 0,
        pricingVersion: "fixture",
        costStatus: "unknown",
        revision: 0,
        attempt: 0,
        provider: "fixture",
        model: "fixture",
        startedAt: at,
        status,
        usageBasis: "missing",
        ...(httpStatus === undefined ? {} : { httpStatus }),
        requestDiagnostic: {
          memoryRecall: {
            version: 1,
            coverage: "recorded",
            recalls: [
              {
                recallEventId: use.recallEventId,
                references: [{ itemId: use.itemId, referenceHash, present: true }],
              },
            ],
          },
        },
      };
      const admission = { ...record, status: "prepared" as const, revision: 0 };
      delete admission.httpStatus;
      ledger.recordPhysicalAttempt(admission);
      if (status !== "prepared") ledger.recordPhysicalAttempt({ ...record, revision: 1 });
      const confirmed = index >= 3;
      assert.equal(hasConfirmedExperienceDelivery(use, options), confirmed);
      const before = structuredClone(use);
      const projected = projectExperienceDelivery(use, options);
      assert.equal(projected.delivery, confirmed ? "carried" : "unknown");
      assert.equal(projected.validation, "pass");
      assert.equal(projected.adoption, "observed");
      assert.equal(projected.referenceContent, referenceContent);
      assert.deepEqual(use, before, "投影不写入或重置历史记录");
      assert.equal(
        hasConfirmedExperienceDelivery({ ...use, referenceHash: "0".repeat(64) }, options),
        false,
      );
      assert.equal(
        hasConfirmedExperienceDelivery({ ...use, providerCallId: "other-call" }, options),
        false,
      );
      assert.equal(
        hasConfirmedExperienceDelivery(
          { ...use, runId: "other-run", hostRunId: "other-host" },
          options,
        ),
        false,
      );
      assert.equal(
        hasConfirmedExperienceDelivery({ ...use, workspaceKey: "other-workspace" }, options),
        false,
      );
      assert.equal(
        hasConfirmedExperienceDelivery({ ...use, physicalAttemptId: "missing" }, options),
        false,
      );
    }
  } finally {
    ledger.close();
    events.close();
    rmSync(root, { recursive: true, force: true });
  }
});
