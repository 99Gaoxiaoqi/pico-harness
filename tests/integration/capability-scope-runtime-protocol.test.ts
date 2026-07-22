import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPABILITY_SCOPE_RUNTIME_CAPABILITY,
  createRuntimeNotification,
  DESKTOP_RUNTIME_METHODS,
  DESKTOP_RUNTIME_SCHEMA_CAPABILITY,
  DESKTOP_RUNTIME_SCHEMA_REVISION,
  isRuntimeMethod,
  LOCAL_RUNTIME_PROTOCOL_VERSION,
  parseDesktopRuntimeResult,
  parseStrictRuntimeParams,
  RUNTIME_ERROR_CODES,
  RUNTIME_METHODS,
  RuntimeProtocolError,
  serializeRuntimeNotification,
  type RuntimeCapabilitySourceMetadata,
  type RuntimeMcpServerInput,
  type RuntimeScopedMcpServer,
  type RuntimeScopedSkill,
} from "../../packages/protocol/src/index.js";

const capabilityMethods = [
  "skills.user.list",
  "skills.effective.list",
  "mcp.user.list",
  "mcp.user.upsert",
  "mcp.user.delete",
  "mcp.effective.list",
] as const;

test("scoped capability methods are explicit Desktop capabilities with strict write contracts", () => {
  for (const method of capabilityMethods) {
    assert.equal(RUNTIME_METHODS.includes(method), true);
    assert.equal(DESKTOP_RUNTIME_METHODS.includes(method), true);
    assert.equal(isRuntimeMethod(method), true);
  }
  assert.equal(RUNTIME_METHODS.includes("config.skills"), true);
  assert.equal(RUNTIME_METHODS.includes("config.mcpServers"), true);

  assert.deepEqual(parseStrictRuntimeParams("skills.user.list", {}), {});
  assert.deepEqual(parseStrictRuntimeParams("skills.effective.list", workspaceParams()), {
    workspacePath: "/workspace",
  });
  assert.deepEqual(parseStrictRuntimeParams("mcp.user.list", {}), {});
  assert.deepEqual(parseStrictRuntimeParams("mcp.effective.list", workspaceParams()), {
    workspacePath: "/workspace",
  });

  const server = {
    name: "github",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_TOKEN: "secret-token" },
    enabled: true,
  } as const satisfies RuntimeMcpServerInput;
  assert.deepEqual(
    parseStrictRuntimeParams("mcp.user.upsert", {
      server,
      expectedRevision: "revision-1",
      idempotencyKey: "upsert-github-1",
    }),
    { server, expectedRevision: "revision-1", idempotencyKey: "upsert-github-1" },
  );
  assert.deepEqual(
    parseStrictRuntimeParams("mcp.user.delete", {
      serverName: "github",
      expectedRevision: "revision-2",
      idempotencyKey: "delete-github-1",
    }),
    {
      serverName: "github",
      expectedRevision: "revision-2",
      idempotencyKey: "delete-github-1",
    },
  );

  for (const params of [
    { server, idempotencyKey: "missing-revision" },
    { server, expectedRevision: "revision-1" },
    {
      serverName: "github",
      expectedRevision: "revision-1",
    },
  ]) {
    assertProtocolError(
      () =>
        "server" in params
          ? parseStrictRuntimeParams("mcp.user.upsert", params)
          : parseStrictRuntimeParams("mcp.user.delete", params),
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
    );
  }
  assertProtocolError(
    () =>
      parseStrictRuntimeParams("mcp.user.upsert", {
        server: { ...server, cwd: "/private/project" },
        expectedRevision: "revision-1",
        idempotencyKey: "reject-path",
      }),
    RUNTIME_ERROR_CODES.INVALID_PARAMS,
  );
});

test("scoped capability results expose opaque provenance without source paths or MCP secrets", () => {
  const userSource = sourceMetadata({ scope: "user", sourceId: "user:skills" });
  const projectSource = sourceMetadata({
    scope: "project",
    sourceId: "project:skills",
    readOnly: true,
  });
  const pluginSource = sourceMetadata({
    scope: "plugin",
    sourceId: "plugin:github",
    readOnly: true,
    effective: false,
    shadowedBy: "user:mcp",
  });
  const userSkill = {
    name: "review",
    description: "Review changes",
    allowedTools: ["read_file"],
    source: userSource,
  } as const satisfies RuntimeScopedSkill;
  const projectSkill = {
    name: "deploy",
    description: "Deploy this workspace",
    source: projectSource,
  } as const satisfies RuntimeScopedSkill;
  const userServer = {
    name: "github",
    transport: "stdio",
    commandLabel: "npx",
    hasArguments: true,
    envKeys: ["GITHUB_TOKEN"],
    enabled: true,
    source: sourceMetadata({ scope: "user", sourceId: "user:mcp" }),
  } as const satisfies RuntimeScopedMcpServer;
  const pluginServer = {
    name: "github",
    transport: "http",
    endpointLabel: "https://example.invalid/mcp",
    headerKeys: ["Authorization"],
    source: pluginSource,
  } as const satisfies RuntimeScopedMcpServer;

  assert.deepEqual(
    parseDesktopRuntimeResult("skills.user.list", {
      skills: [userSkill],
      revision: "user-revision",
    }),
    { skills: [userSkill], revision: "user-revision" },
  );
  assert.deepEqual(
    parseDesktopRuntimeResult("skills.effective.list", {
      skills: [userSkill, projectSkill],
      revisions: revisions(),
    }),
    { skills: [userSkill, projectSkill], revisions: revisions() },
  );
  assert.deepEqual(
    parseDesktopRuntimeResult("mcp.user.list", {
      servers: [userServer],
      revision: "user-revision",
    }),
    { servers: [userServer], revision: "user-revision" },
  );
  assert.deepEqual(
    parseDesktopRuntimeResult("mcp.user.upsert", {
      server: userServer,
      revision: "next-user-revision",
    }),
    { server: userServer, revision: "next-user-revision" },
  );
  assert.deepEqual(
    parseDesktopRuntimeResult("mcp.user.delete", {
      serverName: "github",
      deleted: true,
      revision: "next-user-revision",
    }),
    { serverName: "github", deleted: true, revision: "next-user-revision" },
  );
  assert.deepEqual(
    parseDesktopRuntimeResult("mcp.effective.list", {
      servers: [userServer, pluginServer],
      revisions: revisions(),
    }),
    { servers: [userServer, pluginServer], revisions: revisions() },
  );

  const secret = "must-not-cross-renderer-boundary";
  for (const unsafeServer of [
    { ...userServer, env: { GITHUB_TOKEN: secret } },
    { ...userServer, command: "/private/bin/npx" },
    { ...userServer, args: ["--token", secret] },
    { ...pluginServer, headers: { Authorization: secret } },
    { ...pluginServer, url: `https://user:${secret}@example.invalid/mcp?token=${secret}` },
    { ...pluginServer, sourcePath: "/private/plugin/mcp.json" },
    { ...pluginServer, source: { ...pluginServer.source, path: "/private/plugin" } },
  ]) {
    const error = assertProtocolError(
      () =>
        parseDesktopRuntimeResult("mcp.user.list", {
          servers: [unsafeServer],
          revision: "user-revision",
        }),
      RUNTIME_ERROR_CODES.INVALID_REQUEST,
    );
    assert.equal(error.message.includes(secret), false);
  }
  for (const unsafeSummary of [
    { ...userServer, commandLabel: "/private/bin/npx" },
    { ...userServer, commandLabel: "..\\private\\npx" },
    {
      ...pluginServer,
      endpointLabel: `https://user:${secret}@example.invalid/mcp`,
    },
    {
      ...pluginServer,
      endpointLabel: `https://example.invalid/mcp?token=${secret}#private`,
    },
  ]) {
    const error = assertProtocolError(
      () =>
        parseDesktopRuntimeResult("mcp.effective.list", {
          servers: [unsafeSummary],
          revisions: revisions(),
        }),
      RUNTIME_ERROR_CODES.INVALID_REQUEST,
    );
    assert.equal(error.message.includes(secret), false);
  }
  assertProtocolError(
    () =>
      parseDesktopRuntimeResult("skills.user.list", {
        skills: [{ ...userSkill, sourcePath: "/private/user/skills/review/SKILL.md" }],
        revision: "user-revision",
      }),
    RUNTIME_ERROR_CODES.INVALID_REQUEST,
  );
});

test("runtime schema and config notifications advertise scoped capabilities without secret data", () => {
  assert.equal(DESKTOP_RUNTIME_SCHEMA_REVISION, 7);
  assert.equal(DESKTOP_RUNTIME_SCHEMA_CAPABILITY, "desktop-runtime-schema-v7");
  const ping = {
    pong: true,
    protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
    desktopSchemaRevision: DESKTOP_RUNTIME_SCHEMA_REVISION,
    capabilities: [DESKTOP_RUNTIME_SCHEMA_CAPABILITY, CAPABILITY_SCOPE_RUNTIME_CAPABILITY],
  } as const;
  assert.deepEqual(parseDesktopRuntimeResult("runtime.ping", ping), ping);
  assertProtocolError(
    () =>
      parseDesktopRuntimeResult("runtime.ping", {
        ...ping,
        capabilities: [DESKTOP_RUNTIME_SCHEMA_CAPABILITY],
      }),
    RUNTIME_ERROR_CODES.VERSION_MISMATCH,
  );

  const notification = createRuntimeNotification({
    topic: "config.updated",
    scope: { workspacePath: "/workspace" },
    resourceVersion: 2,
    at: 1,
    payload: {
      scope: "user",
      revision: "opaque-revision",
      capabilities: ["skills", "mcp"],
    },
  });
  const serialized = serializeRuntimeNotification(notification);
  assert.deepEqual(serialized, {
    protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
    eventId: notification.eventId,
    topic: "config.updated",
    scope: { workspacePath: "/workspace" },
    resourceVersion: 2,
    at: 1,
    payload: {
      scope: "user",
      revision: "opaque-revision",
      capabilities: ["skills", "mcp"],
    },
  });
  assert.equal(JSON.stringify(serialized).includes("secret"), false);
});

function workspaceParams(): { readonly workspacePath: string } {
  return { workspacePath: "/workspace" };
}

function revisions(): { readonly user: string; readonly project: string } {
  return { user: "user-revision", project: "project-revision" };
}

function sourceMetadata(input: {
  readonly scope: RuntimeCapabilitySourceMetadata["scope"];
  readonly sourceId: string;
  readonly sourceLabel?: string;
  readonly readOnly?: boolean;
  readonly effective?: boolean;
  readonly shadowedBy?: string;
}): RuntimeCapabilitySourceMetadata {
  return {
    scope: input.scope,
    sourceId: input.sourceId,
    sourceLabel: input.sourceLabel ?? input.sourceId,
    readOnly: input.readOnly ?? false,
    effective: input.effective ?? true,
    ...(input.shadowedBy ? { shadowedBy: input.shadowedBy } : {}),
  };
}

function assertProtocolError(
  operation: () => unknown,
  code: (typeof RUNTIME_ERROR_CODES)[keyof typeof RUNTIME_ERROR_CODES],
): RuntimeProtocolError {
  let error: unknown;
  try {
    operation();
  } catch (candidate) {
    error = candidate;
  }
  assert.ok(error instanceof RuntimeProtocolError);
  assert.equal(error.code, code);
  return error;
}
