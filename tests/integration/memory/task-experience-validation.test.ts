import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import ExcelJS from "exceljs";
import type {
  TaskExperienceCandidate,
  TaskExperienceObservation,
  TaskExperienceTask,
} from "@pico/core";
import {
  spreadsheetInputHasFiniteNumbers,
  validateSpreadsheetTaskExperience,
} from "../../../packages/pico-host/src/task-experience-validation.js";

test("Excel当前范围独立求和只信canonical工具，不采纳模型最终数值；不完整或改变证据保持unknown/stale", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.getCell("A1").value = "范围外标题";
  sheet.getCell("B2").value = 4;
  sheet.getCell("B3").value = 6;
  sheet.getCell("B4").value = 8;
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(await spreadsheetInputHasFiniteNumbers(bytes), false);
  assert.equal(
    await spreadsheetInputHasFiniteNumbers(bytes, { sheet: "Sheet1", range: "B2:B4" }),
    true,
  );
  assert.equal(
    await spreadsheetInputHasFiniteNumbers(bytes, { sheet: "Sheet1", range: "B1:B4" }),
    false,
  );
  const source = { sessionId: "session", runId: "run", turnId: "turn", eventId: "result" };
  const task: TaskExperienceTask = {
    taskId: "task",
    taskVersion: 2,
    workspaceKey: "workspace",
    workDir: "/fixture",
    sessionId: "session",
    runId: "run",
    goal: "计算当前 Excel Sheet1 的 B2:B4 范围 B列总和",
    goalSource: source,
    coverage: "complete",
    throughSequence: 4,
    createdAt: 1,
    updatedAt: 1,
  };
  const observation: TaskExperienceObservation = {
    observationId: "observation",
    taskId: "task",
    taskVersion: 2,
    kind: "tool-result",
    source,
    sequence: 4,
    summary: "模型最终文字声称99",
    coverage: "complete",
    status: "succeeded",
    toolName: "document",
    createdAt: 1,
  };
  const candidate: TaskExperienceCandidate = {
    candidateId: "candidate",
    kind: "task-lesson",
    taskId: "oldtask",
    taskVersion: 1,
    workspaceKey: "workspace",
    workDir: "/fixture",
    sessionId: "oldsession",
    runId: "oldrun",
    failureKey: "key",
    inputEpoch: 0,
    settingsVersion: 1,
    deletionRevision: 0,
    state: "saved",
    lifecycleState: "active",
    goal: "计算",
    content: "在当前数值范围使用sum，并明确无表头。",
    contentVersion: 1,
    recordRevision: 2,
    review: "approved",
    validation: "unknown",
    enabled: true,
    applicability: {
      taskFamily: "spreadsheet",
      toolNames: ["document"],
      conditions: [],
      spreadsheet: { operation: "sum", header: false, dataKind: "finite-numbers" },
    },
    sources: [],
    observationIds: [],
    createdAt: 1,
    updatedAt: 1,
  };
  const args = {
    artifact_id: "current_file",
    action: "analyze",
    sheet: "Sheet1",
    range: "B2:B4",
    column: "B",
    operation: "sum",
    header: false,
  };
  const numeric = {
    sheet: "Sheet1",
    range: "B2:B4",
    dataRange: "B2:B4",
    column: "B",
    operation: "sum",
    header: false,
    groupBy: null,
    filters: [],
    totalRows: 3,
    matchedRows: 3,
    numericValues: 3,
    emptyValues: 0,
    nonNumericValues: 0,
    formulaCacheMissing: 0,
    formulaCacheUsed: 0,
    filterAndGroupFormulaCacheUsed: 0,
    completeNumericCoverage: true,
    result: 18,
  };
  const result = (data = numeric) =>
    JSON.stringify({
      source: { ref: "pico://artifact/current_file", digest, action: "analyze" },
      kind: "spreadsheet",
      text: JSON.stringify(data),
    });
  const input = {
    candidate,
    task,
    observation,
    canonicalArguments: args,
    canonicalResult: result(),
    artifactBytes: bytes,
    artifactDigest: digest,
    currentArtifactId: "current_file",
    now: 10,
  };
  assert.deepEqual(await validateSpreadsheetTaskExperience(input), {
    adoption: "observed",
    validation: "pass",
    sources: [source],
  });
  assert.equal((await validateSpreadsheetTaskExperience({...input, task:{...task,goal:"请用document计算Excel附件Sheet1的B2:B4合计。"}})).validation, "pass");
  assert.equal((await validateSpreadsheetTaskExperience({...input, task:{...task,goal:"请读取Sheet1的B2:B4数据。"}})).validation, "unknown");
  assert.equal(
    (
      await validateSpreadsheetTaskExperience({
        ...input,
        task: { ...task, goal: "计算当前 Sheet1 的 B2:B4 总和" },
      })
    ).validation,
    "pass",
  );
  assert.equal(
    (
      await validateSpreadsheetTaskExperience({
        ...input,
        task: { ...task, goal: "计算当前 Sheet1 的 A2:B4 总和" },
      })
    ).validation,
    "unknown",
  );
  assert.equal(
    (
      await validateSpreadsheetTaskExperience({
        ...input,
        task: { ...task, goal: "计算当前范围总和" },
      })
    ).validation,
    "unknown",
  );
  assert.equal(
    (await validateSpreadsheetTaskExperience({ ...input, currentArtifactId: "other_file" }))
      .validation,
    "unknown",
  );
  assert.deepEqual(
    await validateSpreadsheetTaskExperience({
      ...input,
      canonicalArguments: { ...args, range: "B2:B3" },
      canonicalResult: result({
        ...numeric,
        range: "B2:B3",
        dataRange: "B2:B3",
        totalRows: 2,
        matchedRows: 2,
        numericValues: 2,
        result: 10,
      }),
    }),
    { adoption: "not_applied", validation: "unknown", sources: [source] },
  );
  assert.equal(
    (
      await validateSpreadsheetTaskExperience({
        ...input,
        canonicalResult: result({ ...numeric, result: 99 }),
      })
    ).validation,
    "fail",
  );
  assert.equal(
    (await validateSpreadsheetTaskExperience({ ...input, artifactDigest: "f".repeat(64) }))
      .validation,
    "stale",
  );
  assert.equal(
    (
      await validateSpreadsheetTaskExperience({
        ...input,
        observation: { ...observation, taskVersion: 1 },
      })
    ).validation,
    "unknown",
  );
  assert.equal(
    (
      await validateSpreadsheetTaskExperience({
        ...input,
        canonicalArguments: { ...args, header: true },
      })
    ).adoption,
    "not_applied",
  );
  assert.equal(
    (
      await validateSpreadsheetTaskExperience({
        ...input,
        canonicalResult: result({ ...numeric, completeNumericCoverage: false }),
      })
    ).validation,
    "unknown",
  );
  sheet.getCell("B2").value = { formula: "2+2", result: 4 };
  const formulaBytes = Buffer.from(await workbook.xlsx.writeBuffer());
  const formulaDigest = createHash("sha256").update(formulaBytes).digest("hex");
  assert.equal(await spreadsheetInputHasFiniteNumbers(formulaBytes, { range: "B2:B4" }), false);
  const formulaResult = JSON.stringify({
    source: { ref: "pico://artifact/current_file", digest: formulaDigest, action: "analyze" },
    kind: "spreadsheet",
    text: JSON.stringify(numeric),
  });
  assert.equal(
    (
      await validateSpreadsheetTaskExperience({
        ...input,
        canonicalResult: formulaResult,
        artifactBytes: formulaBytes,
        artifactDigest: formulaDigest,
      })
    ).validation,
    "unknown",
  );
});
