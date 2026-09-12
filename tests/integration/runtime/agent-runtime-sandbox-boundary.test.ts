import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ApprovalManager, type ApprovalNotice } from "../../../src/approval/manager.js";
import { SilentReporter } from "../../../src/engine/reporter.js";
import { projectRuntimeSessionState } from "../../../src/engine/session-runtime-projection.js";
import { globalSessionManager } from "../../../src/engine/session.js";
import { resolvePicoPaths } from "../../../src/paths/pico-paths.js";
import type { LLMProvider } from "../../../src/provider/interface.js";
import { executeAgentRuntime } from "../../../src/runtime/agent-runtime.js";
import {
  canWritePath,
  compileRuntimePermissionProfile,
  type ExecutionBoundary,
  type RuntimePermissionMode,
  type SandboxBoundaryScope,
} from "../../../src/safety/permission-profile.js";
import { SqliteRuntimeEventStore } from "../../../src/storage/sqlite/sqlite-runtime-event-store.js";

const REQUEST_BOUNDARY_TOOL = "request_sandbox_boundary";

interface RuntimeFixture {
  readonly workDir: string;
  readonly picoHome: string;
  readonly sessionId: string;
  readonly externalDir: string;
}

test("foreground ask/auto sessions durably apply host-approved sandbox boundary requests", async (t) => {
  const cases: readonly {
    mode: Exclude<RuntimePermissionMode, "full-access">;
    scope: SandboxBoundaryScope;
  }[] = [
    { mode: "ask", scope: "exact" },
    { mode: "auto", scope: "subtree" },
  ];

  for (const { mode, scope } of cases) {
    await t.test(`${mode} approves an external ${scope} path and network`, async (t) => {
      const fixture = await createFixture(t, `approved-${mode}-${scope}`);
      const canonicalExternalDir = await realpath(fixture.externalDir);
      const target =
        scope === "exact"
          ? join(canonicalExternalDir, "approved-target.txt")
          : canonicalExternalDir;
      if (scope === "exact") await writeFile(target, "outside workspace\n", "utf8");

      const initial = compileRuntimePermissionProfile({
        collaborationMode: "agent",
        permissionMode: mode,
      });
      assert.equal(initial.kind, "managed");
      assert.equal(
        canWritePath(initial.profile, target, boundaryMatchContext(fixture.workDir)),
        false,
        "the fixture must start outside the managed workspace boundary",
      );

      const approvalManager = new ApprovalManager(60_000);
      const notices: ApprovalNotice[] = [];
      const callId = `boundary-${mode}-${scope}`;
      let settlement: unknown;
      let providerCalls = 0;
      const provider: LLMProvider = {
        async generate(messages, tools) {
          providerCalls += 1;
          assert.ok(
            tools.some((tool) => tool.name === REQUEST_BOUNDARY_TOOL),
            `${REQUEST_BOUNDARY_TOOL} must be visible to the managed foreground provider`,
          );
          if (providerCalls === 1) {
            return {
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  id: callId,
                  name: REQUEST_BOUNDARY_TOOL,
                  arguments: JSON.stringify({
                    expansion: {
                      filesystem: { entries: [{ path: target, access: "write", scope }] },
                      network: { enabled: true },
                    },
                    justification: `Need ${scope} output and network access.`,
                  }),
                },
              ],
            };
          }

          const toolResult = messages.findLast((message) => message.toolCallId === callId);
          assert.ok(toolResult, "the provider must receive the boundary settlement");
          settlement = JSON.parse(toolResult.content) as unknown;
          return { role: "assistant", content: "boundary applied" };
        },
      };

      const result = await executeAgentRuntime(
        {
          prompt: "Request the required external sandbox access.",
          dir: fixture.workDir,
          sessionSelection: { mode: "new", sessionId: fixture.sessionId },
          provider: "openai",
          modelRouteId: "test/test",
          collaborationMode: "agent",
          permissionMode: mode,
          allowedTools: [REQUEST_BOUNDARY_TOOL],
        },
        {
          picoHome: fixture.picoHome,
          provider,
          reporter: new SilentReporter(),
          approvalManager,
          approvalNotifier: (notice) => {
            notices.push(notice);
            approvalManager.resolveApproval(notice.taskId, true, "approved by test host");
          },
        },
      );

      assert.equal(result.finalMessage, "boundary applied");
      assert.equal(providerCalls, 2);
      assert.deepEqual(settlement, {
        status: "applied",
        requestId: notices[0]?.taskId,
        boundaryRevision: 1,
      });
      assert.equal(notices.length, 1);
      assert.equal(notices[0]?.toolName, REQUEST_BOUNDARY_TOOL);
      const requested = JSON.parse(notices[0]!.args) as {
        baseRevision: number;
        expansion: {
          filesystem: { entries: Array<{ path: string; access: string; scope: string }> };
          network: { enabled: boolean };
        };
      };
      assert.equal(requested.baseRevision, 0);
      assert.deepEqual(requested.expansion, {
        filesystem: { entries: [{ path: target, access: "write", scope }] },
        network: { enabled: true },
      });

      const state = await readDurableState(fixture);
      assert.equal(state.settings?.permissionMode, mode);
      assert.ok(state.boundary?.kind === "managed");
      assert.equal(state.boundary.revision, 1);
      assert.equal(state.boundary.profile.network.kind, "enabled");
      assert.equal(
        canWritePath(state.boundary.profile, target, boundaryMatchContext(fixture.workDir)),
        true,
      );
      assert.ok(
        state.boundary.profile.fileSystem.entries.some(
          (entry) =>
            entry.kind === "path" &&
            entry.path === target &&
            entry.access === "write" &&
            entry.match === scope,
        ),
        `the durable boundary must retain the approved ${scope} path`,
      );
    });
  }
});

test("a rejected sandbox boundary request leaves the durable managed boundary unchanged", async (t) => {
  const fixture = await createFixture(t, "denied");
  const target = await realpath(fixture.externalDir);
  const expectedBoundary = compileRuntimePermissionProfile({
    collaborationMode: "agent",
    permissionMode: "ask",
  });
  const approvalManager = new ApprovalManager(60_000);
  const notices: ApprovalNotice[] = [];
  const callId = "boundary-denied";
  let settlement: unknown;
  let providerCalls = 0;
  const provider: LLMProvider = {
    async generate(messages, tools) {
      providerCalls += 1;
      assert.ok(tools.some((tool) => tool.name === REQUEST_BOUNDARY_TOOL));
      if (providerCalls === 1) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: callId,
              name: REQUEST_BOUNDARY_TOOL,
              arguments: JSON.stringify({
                expansion: {
                  filesystem: {
                    entries: [{ path: target, access: "write", scope: "subtree" }],
                  },
                  network: { enabled: true },
                },
                justification: "Need rejected external access.",
              }),
            },
          ],
        };
      }
      const toolResult = messages.findLast((message) => message.toolCallId === callId);
      assert.ok(toolResult);
      settlement = JSON.parse(toolResult.content) as unknown;
      return { role: "assistant", content: "boundary denied" };
    },
  };

  await executeAgentRuntime(
    {
      prompt: "Request access that the host will reject.",
      dir: fixture.workDir,
      sessionSelection: { mode: "new", sessionId: fixture.sessionId },
      provider: "openai",
      modelRouteId: "test/test",
      collaborationMode: "agent",
      permissionMode: "ask",
      allowedTools: [REQUEST_BOUNDARY_TOOL],
    },
    {
      picoHome: fixture.picoHome,
      provider,
      reporter: new SilentReporter(),
      approvalManager,
      approvalNotifier: (notice) => {
        notices.push(notice);
        approvalManager.resolveApproval(notice.taskId, false, "rejected by test host");
      },
    },
  );

  assert.equal(notices.length, 1);
  assert.deepEqual(settlement, {
    status: "denied",
    requestId: notices[0]?.taskId,
    boundaryRevision: 0,
    reason: "rejected by test host",
  });
  const state = await readDurableState(fixture);
  assert.deepEqual(state.boundary, expectedBoundary);
  assert.ok(state.boundary?.kind === "managed");
  assert.equal(
    canWritePath(state.boundary.profile, target, boundaryMatchContext(fixture.workDir)),
    false,
  );
});

test("full-access and plan providers never receive request_sandbox_boundary", async (t) => {
  for (const mode of ["full-access", "plan"] as const) {
    await t.test(mode, async (t) => {
      const fixture = await createFixture(t, `hidden-${mode}`);
      let providerCalls = 0;
      const provider: LLMProvider = {
        async generate(_messages, tools) {
          providerCalls += 1;
          assert.equal(
            tools.some((tool) => tool.name === REQUEST_BOUNDARY_TOOL),
            false,
          );
          if (mode === "plan") {
            return {
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  id: "submit-hidden-boundary-plan",
                  name: "submit_plan",
                  arguments: JSON.stringify({
                    title: "No boundary expansion in plan mode",
                    steps: [{ title: "Execute later", description: "Stay read-only for now" }],
                    operationId: "submit-hidden-boundary-plan",
                  }),
                },
              ],
            };
          }
          return { role: "assistant", content: "full access has no boundary request tool" };
        },
      };

      const result = await executeAgentRuntime(
        {
          prompt: "Inspect the available provider tools.",
          dir: fixture.workDir,
          sessionSelection: { mode: "new", sessionId: fixture.sessionId },
          provider: "openai",
          modelRouteId: "test/test",
          collaborationMode: mode === "plan" ? "plan" : "agent",
          permissionMode: mode === "full-access" ? "full-access" : "ask",
        },
        {
          picoHome: fixture.picoHome,
          provider,
          reporter: new SilentReporter(),
        },
      );

      assert.equal(providerCalls, 1);
      if (mode === "plan") assert.equal(result.handoff?.kind, "plan_handoff");
    });
  }
});

async function createFixture(t: TestContext, suffix: string): Promise<RuntimeFixture> {
  // The default managed boundary already includes the OS temp directory. Keep the
  // external fixture under the home directory so this test proves a real expansion.
  const root = await mkdtemp(join(homedir(), ".pico-boundary-runtime-"));
  const workDir = join(root, "work");
  const externalDir = join(root, "external");
  const picoHome = join(root, "pico-home");
  const sessionId = `agent-runtime-boundary-${suffix}`;
  await Promise.all([
    mkdir(workDir, { recursive: true }),
    mkdir(externalDir, { recursive: true }),
    mkdir(picoHome, { recursive: true }),
  ]);
  t.after(async () => {
    const released = globalSessionManager.delete(sessionId, workDir, { picoHome });
    await released?.close();
    await rm(root, { recursive: true, force: true });
  });
  return { workDir, picoHome, sessionId, externalDir };
}

function boundaryMatchContext(workDir: string) {
  return { workspaceRoots: [workDir], tmpdir: tmpdir(), slashTmp: "/tmp" };
}

async function readDurableState(fixture: RuntimeFixture): Promise<{
  readonly settings?: { readonly permissionMode: string };
  readonly boundary?: ExecutionBoundary;
}> {
  const store = new SqliteRuntimeEventStore({
    storageRoot: resolvePicoPaths(fixture.workDir, { picoHome: fixture.picoHome }).workspace.root,
  });
  try {
    return projectRuntimeSessionState(await store.readSession(fixture.sessionId));
  } finally {
    store.close();
  }
}
