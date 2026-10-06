import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { Session } from "@pico/pico-host/session";
import {
  ClaudeCodeSessionAdapter,
  CodexSessionAdapter,
  OpenCodeSessionAdapter,
} from "@pico/storage";

test("Codex、Claude Code 与 OpenCode 的本地对话可被发现并转换为 Pico 消息", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-external-session-import-"));
  context.after(async () => rm(root, { recursive: true, force: true }));

  const codexHome = join(root, "codex");
  const codexId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const codexPath = join(codexHome, "sessions", "2026", "10", "06", `rollout-${codexId}.jsonl`);
  await mkdir(join(codexHome, "sessions", "2026", "10", "06"), { recursive: true });
  await writeFile(
    codexPath,
    [
      JSON.stringify({ type: "session_meta", payload: { id: codexId, cwd: "/workspace/codex" } }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-10-06T01:00:00Z",
        payload: { type: "user_message", message: "修复 Codex 问题" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-10-06T01:00:00.500Z",
        payload: { type: "user_message", message: "修复 Codex 问题" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-10-06T01:00:01Z",
        payload: { type: "agent_message", message: "已经修复。" },
      }),
    ].join("\n") + "\n",
  );

  const claudeHome = join(root, "claude");
  const claudeId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await mkdir(join(claudeHome, "projects", "workspace-claude"), { recursive: true });
  await writeFile(
    join(claudeHome, "projects", "workspace-claude", `${claudeId}.jsonl`),
    [
      JSON.stringify({
        type: "user",
        uuid: "claude-user-1",
        cwd: "/workspace/claude",
        message: { role: "user", content: "整理 Claude 项目" },
      }),
      JSON.stringify({
        type: "user",
        uuid: "claude-user-2",
        cwd: "/workspace/claude",
        message: { role: "user", content: "整理 Claude 项目" },
      }),
      JSON.stringify({
        type: "assistant",
        cwd: "/workspace/claude",
        message: { role: "assistant", content: [{ type: "text", text: "已整理。" }] },
      }),
    ].join("\n") + "\n",
  );

  const opencodePath = join(root, "opencode.db");
  const db = new DatabaseSync(opencodePath);
  try {
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER, parent_id TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    `);
    db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, NULL, NULL)").run(
      "ses_external_import_1",
      "OpenCode 会话",
      "/workspace/opencode",
      1791240000000,
      1791240001000,
    );
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
      "msg-user",
      "ses_external_import_1",
      1791240000000,
      JSON.stringify({ role: "user" }),
    );
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
      "msg-user-repeat",
      "ses_external_import_1",
      1791240000500,
      JSON.stringify({ role: "user" }),
    );
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
      "msg-assistant",
      "ses_external_import_1",
      1791240001000,
      JSON.stringify({ role: "assistant" }),
    );
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)").run(
      "part-user",
      "msg-user",
      "ses_external_import_1",
      1791240000000,
      JSON.stringify({ type: "text", text: "检查 OpenCode 任务" }),
    );
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)").run(
      "part-user-repeat",
      "msg-user-repeat",
      "ses_external_import_1",
      1791240000500,
      JSON.stringify({ type: "text", text: "检查 OpenCode 任务" }),
    );
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)").run(
      "part-assistant",
      "msg-assistant",
      "ses_external_import_1",
      1791240001000,
      JSON.stringify({ type: "text", text: "检查完成。" }),
    );
  } finally {
    db.close();
  }

  const codex = new CodexSessionAdapter(codexHome);
  const claude = new ClaudeCodeSessionAdapter(claudeHome);
  const opencode = new OpenCodeSessionAdapter(opencodePath);
  for (const adapter of [codex, claude, opencode]) assert.equal(await adapter.detect(), true);

  const imported = await Promise.all([
    codex.readSession(codexId),
    claude.readSession(claudeId),
    opencode.readSession("ses_external_import_1"),
  ]);
  assert.deepEqual(
    imported.map(({ messages }) => messages.map(({ role }) => role)),
    [
      ["user", "user", "assistant"],
      ["user", "user", "assistant"],
      ["user", "user", "assistant"],
    ],
  );
  assert.deepEqual(
    imported.map(({ messages }) => messages.at(-1)?.content),
    ["已经修复。", "已整理。", "检查完成。"],
  );
  assert.deepEqual(
    imported.map(({ summary }) => summary.cwd),
    ["/workspace/codex", "/workspace/claude", "/workspace/opencode"],
  );

  const workDir = join(root, "import-workspace");
  await mkdir(workDir);
  const sessionOptions = {
    persistence: true,
    picoHome: join(root, "pico-home"),
    runtimePort: createEngineRuntimePort(),
  };
  let session = new Session("external-import-recovery", workDir, sessionOptions);
  await session.recover();
  await session.importHistoryMessages(imported[0]!.messages);
  assert.deepEqual(session.getHistory(), imported[0]!.messages);
  const events = (await session.runtimeEventStore!.readSessionEntries(session.id)).map(
    ({ event }) => event,
  );
  assert.equal(events.filter(({ kind }) => kind === "message.committed").length, 3);
  assert.equal(
    events.some(({ kind }) => kind === "run.started" || kind === "run.terminal"),
    false,
  );
  await session.close();

  session = new Session("external-import-recovery", workDir, sessionOptions);
  try {
    await session.recover();
    assert.deepEqual(session.getHistory(), imported[0]!.messages);
  } finally {
    await session.close();
  }
});
