import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  createRuntimeRequest,
  parseRuntimeResult,
  parseStrictRuntimeParams,
  type RuntimeResult,
} from "@pico/protocol";
import { DesktopRuntimeService } from "@pico/pico-host/desktop-runtime-service";
import {
  WorkspaceRuntimeService,
  type DaemonRunExecution,
} from "@pico/pico-host/workspace-runtime-service";
import { SqliteDesktopConversationStateStore } from "@pico/pico-host";
import { globalSessionManager } from "@pico/pico-host/session";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { SessionSubscriptionRegistry } from "@pico/pico-host/session-subscription-owner";
import { SqliteSessionContinuitySource } from "@pico/pico-host/sqlite-session-continuity-source";
import { SkillLoader } from "@pico/pico-host/skill-catalog";
import { writeDesktopModelRouting } from "../../fixtures/desktop-model-routing.js";

async function fixture(context: import("node:test").TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pico-multi-skills-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "home");
  await mkdir(workspace);
  await writeDesktopModelRouting(picoHome);
  const workspacePath = await realpath(workspace);
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(workspacePath);
  const env = { PICO_HOME: picoHome, PICO_TEST_TOKEN: "test-token" };
  const executions: { prompt: string; execution?: DaemonRunExecution }[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = new WorkspaceRuntimeService({
    env,
    execute: async ({ prompt, execution, context: run }) => {
      executions.push({ prompt, ...(execution ? { execution } : {}) });
      await Promise.race([
        gate,
        new Promise<void>((resolve) =>
          run.signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
    },
  });
  const store = new SqliteDesktopConversationStateStore({ picoHome });
  const desktop = new DesktopRuntimeService({
    runtimeService: runtime,
    trustStore,
    env,
    conversationStateStore: store,
  });
  const source = new SqliteSessionContinuitySource({
    picoHome,
    readMetadata: (workspace, id) => desktop.readSessionContinuityMetadata(workspace, id),
  });
  const registry = new SessionSubscriptionRegistry("multi-skill-host", source);
  const openSubscription = (sessionId: string) =>
    registry.open(
      { workspacePath, sessionId },
      {
        connectionId: "test",
        push: async () => undefined,
      },
    );
  const sessions = new Set<string>();
  context.after(async () => {
    release();
    registry.shutdown();
    await desktop.close();
    for (const sessionId of sessions)
      await globalSessionManager.delete(sessionId, workspacePath, { picoHome })?.close();
    await rm(root, { recursive: true, force: true });
  });
  async function skill(name: string, extra = "", body = `instruction-${name}`) {
    const path = join(workspacePath, ".pico", "skills", name, "SKILL.md");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      `---\nname: ${name}\ndescription: controlled fixture\n${extra}---\n${body}\n`,
    );
    return path;
  }
  async function send(
    input: unknown,
    idempotencyKey: string,
    sessionId?: string,
    behavior?: string,
  ) {
    const result = (await desktop.handle(
      createRuntimeRequest("session.send", {
        workspacePath,
        input: input as never,
        idempotencyKey,
        ...(sessionId ? { sessionId } : {}),
        ...(behavior ? { behavior } : {}),
      }),
    )) as RuntimeResult<"session.send">;
    sessions.add(result.session.sessionId);
    return result;
  }
  return {
    workspacePath,
    picoHome,
    desktop,
    store,
    executions,
    release,
    skill,
    send,
    openSubscription,
  };
}

test(
  "structured skills execute in one Run with canonical references, intersected restrictions and durable queue replay",
  { timeout: 30_000 },
  async (context) => {
    const f = await fixture(context);
    await f.skill("alpha", "allowed-tools: read_file, write_file\nmodel: test/coder\nhooks: {}\n");
    await f.skill("beta", "allowed-tools: read_file, shell\nmodel: test/coder\nhooks: {}\n");
    const input = {
      kind: "text",
      text: "complete task",
      skills: [{ name: "ALPHA" }, { name: "beta" }, { name: "alpha" }],
    };
    const first = await f.send(input, "first");
    while (!f.executions.length) await delay(10);
    assert.equal(f.executions.length, 1);
    const execution = f.executions[0]!;
    assert.ok(
      execution.prompt.indexOf("instruction-alpha") < execution.prompt.indexOf("instruction-beta"),
    );
    assert.equal(execution.prompt.match(/instruction-alpha/g)?.length, 1);
    assert.ok(execution.prompt.endsWith("用户任务：\ncomplete task"));
    assert.deepEqual(execution.execution?.allowedTools, ["read_file"]);
    assert.equal(execution.execution?.requestedModel, "test/coder");
    assert.deepEqual(
      execution.execution?.skillActivations?.map((item) => item.name),
      ["alpha", "beta"],
    );
    assert.deepEqual(await f.send(input, "first"), first);
    const subscription = parseRuntimeResult(
      "session.subscription.open",
      await f.openSubscription(first.session.sessionId),
    );
    const user = subscription.durableTail.find(
      (record) => record.item.kind === "userMessage",
    )!.item;
    assert.equal(user.content, "complete task");
    assert.deepEqual(
      (user.skills as { name: string }[]).map((item) => item.name),
      ["alpha", "beta"],
    );
    assert.ok(
      (user.skills as { sourceId: string; sourcePath: string }[]).every(
        (item) => item.sourceId && item.sourcePath,
      ),
    );
    await assert.rejects(
      f.send(input, "steer", first.session.sessionId, "steer"),
      /Queue 或 Replace/,
    );
    const queued = await f.send(input, "queue", first.session.sessionId, "queue");
    assert.equal(queued.disposition, "queued");
    const recovered = await new SqliteDesktopConversationStateStore({
      picoHome: f.picoHome,
    }).listQueued(f.workspacePath, first.session.sessionId);
    assert.deepEqual(recovered[0]?.input.skills, user.skills);
    const queuedView = parseRuntimeResult(
      "session.subscription.open",
      await f.openSubscription(first.session.sessionId),
    );
    assert.deepEqual(queuedView.queuedInputs[0]?.input.skills, user.skills);
    f.release();
    for (let count = 0; count < 300 && f.executions.length < 2; count++) await delay(10);
    assert.equal(f.executions.length, 2);
    assert.equal(f.executions[1]?.prompt, execution.prompt);
  },
);

test(
  "invalid sources, missing skills, model conflicts and malformed references fail before session or Run admission",
  { timeout: 30_000 },
  async (context) => {
    const f = await fixture(context);
    await f.skill("alpha", "model: test/coder\n");
    await f.skill("beta", "model: test/other\n");
    const catalog = await new SkillLoader(f.workspacePath, { picoHome: f.picoHome }).list();
    const alpha = catalog.find((skill) => skill.name === "alpha")!;
    for (const [key, skills, pattern] of [
      ["missing", [{ name: "alpha" }, { name: "missing" }], /未找到 Skill/],
      [
        "source",
        [{ name: "alpha", sourceId: "stale", sourcePath: alpha.sourcePath }],
        /来源已变化/,
      ],
      ["models", [{ name: "alpha" }, { name: "beta" }], /模型冲突/],
    ] as const)
      await assert.rejects(f.send({ kind: "text", text: "task", skills }, key), pattern);
    for (const input of [
      { kind: "text", text: "task", skills: [] },
      { kind: "text", text: "task", skills: [{ name: "alpha", typo: "ignored" }] },
      { kind: "skill", name: "alpha", skills: [{ name: "alpha" }] },
      { kind: "text", text: "task", skills: Array.from({ length: 17 }, () => ({ name: "alpha" })) },
    ])
      assert.throws(() =>
        parseStrictRuntimeParams("session.send", {
          workspacePath: f.workspacePath,
          input,
          idempotencyKey: "invalid",
        }),
      );
    assert.deepEqual(
      (
        (await f.desktop.handle(
          createRuntimeRequest("session.list", { workspacePath: f.workspacePath }),
        )) as { sessions: unknown[] }
      ).sessions,
      [],
    );
    assert.equal(f.executions.length, 0);
    const valid = { kind: "text", text: "task", skills: [{ name: "alpha", sourceId: "stale" }] };
    await assert.rejects(f.send(valid, "retry"), /来源已变化/);
    valid.skills[0]!.sourceId = alpha.source!.id;
    assert.equal((await f.send(valid, "retry")).disposition, "started");
  },
);

test(
  "queued structured skills reject a changed catalog before committing another input or executing",
  { timeout: 30_000 },
  async (context) => {
    const f = await fixture(context);
    const alphaPath = await f.skill("alpha");
    await f.skill("beta");
    const first = await f.send({ kind: "text", text: "first" }, "first");
    while (!f.executions.length) await delay(10);
    await f.send(
      { kind: "text", text: "queued", skills: [{ name: "alpha" }, { name: "beta" }] },
      "queue",
      first.session.sessionId,
      "queue",
    );
    let failure!: () => void;
    const rejected = new Promise<void>((resolve) => {
      failure = resolve;
    });
    const unsubscribe = f.desktop.subscribe((notification) => {
      if (notification.topic === "runtime.error") failure();
    });
    context.after(unsubscribe);
    await rm(alphaPath);
    f.release();
    await Promise.race([
      rejected,
      delay(5000).then(() => {
        throw new Error("queued activation did not report the missing skill");
      }),
    ]);
    assert.equal(f.executions.length, 1);
    assert.equal((await f.store.listQueued(f.workspacePath, first.session.sessionId)).length, 1);
    const projection = await f.openSubscription(first.session.sessionId);
    assert.equal(
      projection.durableTail.filter(({ item }) => item.kind === "userMessage").length,
      1,
    );
  },
);

test("structured skill without arguments keeps activation and visible identity", async (context) => {
  const f = await fixture(context);
  await f.skill("alpha", "allowed-tools: []\n");
  const sent = await f.send(
    { kind: "text", text: "", skills: [{ name: "alpha" }] },
    "no-arguments",
  );
  for (let count = 0; count < 100 && !f.executions.length; count++) await delay(10);
  assert.equal(f.executions.length, 1);
  assert.ok(f.executions[0]?.prompt.includes("instruction-alpha"));
  const subscription = parseRuntimeResult(
    "session.subscription.open",
    await f.openSubscription(sent.session.sessionId),
  );
  const user = subscription.durableTail.find((record) => record.item.kind === "userMessage")?.item;
  assert.equal(user?.content, "/alpha");
  assert.deepEqual(
    (user?.skills as { name: string }[]).map((skill) => skill.name),
    ["alpha"],
  );
});
