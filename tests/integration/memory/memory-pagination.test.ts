import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { MemoryItemWrite } from "@pico/core/atomic-memory-contracts";
import { DesktopAtomicMemoryService } from "@pico/pico-host/desktop-atomic-memory-service";
import { resolvePicoPaths } from "@pico/pico-host";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { createWorkspaceCommands } from "@pico/cli/workspace-commands";
import type { RpcCommandRuntime } from "@pico/cli/rpc-command-runtime";
import {
  MEMORY_PAGINATION_RUNTIME_CAPABILITY,
  LOCAL_RUNTIME_PROTOCOL_VERSION,
  encodeRuntimeFrame,
  parseRuntimeMessage,
  parseRuntimeResult,
  RuntimeProtocolError,
  type JsonValue,
  type RuntimeMethod,
  type RuntimeParams,
  type RuntimeResult,
} from "@pico/protocol";

test("memory pagination survives long content and provenance, filters before limits and rejects changed snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-memory-pages-"));
  const workspacePath = join(root, "workspace");
  const other = join(root, "other");
  const picoHome = join(root, "home");
  await Promise.all([mkdir(workspacePath), mkdir(other)]);
  const workspaceKey = resolvePicoPaths(workspacePath, { picoHome }).workspace.id;
  let id = 0;
  const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"), {
    now: () => 10_000,
    idFactory: () => `item-${String(id++).padStart(6, "0")}`,
  });
  const write = (index: number): MemoryItemWrite => ({
    content: `${String(index).padStart(6, "0")} ${index < 260 ? "汉".repeat(1993) : "项目记忆"}`,
    kind: index === 1100 ? "knowledge" : "note",
    statementType: "fact",
    temporalType: "undated",
    scopeType: index === 1102 ? "global" : "workspace",
    scopeKey: index === 1102 ? null : index === 1101 ? "other-private-workspace" : workspaceKey,
    observedAt: 10_000,
    origin: index === 0 ? "agent_extracted" : "user_requested",
    keys: [{ key: "项目", keyType: "concept", keyOrigin: "user" }],
    sources:
      index === 0
        ? Array.from({ length: 256 }, (_, source) => ({
            sessionId: "会".repeat(512),
            runId: "运".repeat(512),
            turnId: "轮".repeat(512),
            eventId: `${String(source).padStart(3, "0")}${"引".repeat(509)}`,
          }))
        : [],
  });
  const service = new DesktopAtomicMemoryService({
    picoHome,
    now: () => 10_000,
    publish: () => {},
  });
  try {
    for (let first = 0; first < 1103; first += 32)
      await store.applyMutations({
        operationId: `seed-${first}`,
        mutations: Array.from({ length: Math.min(32, 1103 - first) }, (_, offset) => ({
          type: "create" as const,
          item: write(first + offset),
        })),
      });
    await store.applyMutations({
      operationId: "archive-target",
      mutations: [{ type: "archive", itemId: "item-001100", expectedVersion: 1 }],
    });
    assert.ok(
      Buffer.byteLength(JSON.stringify(await service.get(workspacePath, "item-000000"))) > 983_040,
    );
    const firstPage = parseRuntimeResult(
      "memory.list",
      await service.list(workspacePath, {
        workspacePath,
        paged: true,
        limit: 1000,
      }),
    );
    assert.ok(firstPage.pageInfo);
    assert.ok(
      firstPage.items.length > 0 && firstPage.items.length < 260,
      "byte budget trims below quantity limit",
    );
    assert.deepEqual(firstPage.pageInfo.counts, { active: 1101, archived: 1, total: 1102 });
    assert.equal(firstPage.items[0]?.sourceCount, 256);
    assert.ok(firstPage.items[0]?.firstSource);
    assert.equal(Object.hasOwn(firstPage.items[0]!, "sources"), false);
    const ids = firstPage.items.map((item) => item.itemId);
    const requestId = "\u0000".repeat(512);
    assert.doesNotThrow(() =>
      parseRuntimeMessage(
        JSON.stringify({
          kind: "request",
          protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
          requestId,
          method: "memory.list",
          params: { workspacePath, paged: true },
        }),
      ),
    );
    assert.throws(
      () =>
        parseRuntimeMessage(
          JSON.stringify({
            kind: "request",
            protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
            requestId: `${requestId}x`,
            method: "memory.list",
            params: { workspacePath, paged: true },
          }),
        ),
      (error: unknown) => error instanceof RuntimeProtocolError && error.code === "INVALID_REQUEST",
    );
    let page: RuntimeResult<"memory.list"> = firstPage;
    for (;;) {
      assert.doesNotThrow(() =>
        encodeRuntimeFrame({
          kind: "response",
          protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
          requestId,
          ok: true,
          result: page as unknown as JsonValue,
        }),
      );
      assert.ok(
        Buffer.byteLength(
          JSON.stringify({ requestId: "\u0000".repeat(128), ok: true, value: page }),
        ) <= 983_040,
      );
      if (!page.pageInfo?.nextCursor) break;
      page = parseRuntimeResult(
        "memory.list",
        await service.list(workspacePath, {
          workspacePath,
          paged: true,
          limit: 1000,
          cursor: page.pageInfo.nextCursor,
        }),
      );
      assert.ok(page.pageInfo);
      assert.equal(page.pageInfo.revision, firstPage.pageInfo.revision);
      ids.push(...page.items.map((item) => item.itemId));
    }
    assert.equal(ids.length, 1102);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(
      ids,
      [...ids].sort(),
      "same timestamp ordering stays stable across byte-trimmed pages",
    );
    assert.equal(ids.includes("item-001101"), false, "another workspace stays inaccessible");
    assert.equal(ids.includes("item-001102"), true, "global memory is authorized");
    const filtered = parseRuntimeResult(
      "memory.list",
      await service.list(workspacePath, {
        workspacePath,
        paged: true,
        lifecycleStates: ["archived"],
        kinds: ["knowledge"],
        limit: 1,
      }),
    );
    assert.equal(
      filtered.items[0]?.itemId,
      "item-001100",
      "filter finds the item beyond the old 1000-row cap",
    );
    assert.deepEqual(filtered.pageInfo?.counts, { active: 0, archived: 1, total: 1 });
    const cursor = firstPage.pageInfo.nextCursor!;
    for (const params of [
      { workspacePath: other, cursor },
      { workspacePath, cursor, kinds: ["knowledge" as const] },
      { workspacePath, cursor: "invalid" },
    ])
      await assert.rejects(
        service.list(params.workspacePath, { ...params, paged: true }),
        (error: unknown) =>
          error instanceof RuntimeProtocolError && error.code === "INVALID_PARAMS",
      );
    // All Item mutation paths invalidate continuations, even if the affected item was on an earlier page.
    let current = (await service.get(workspacePath, "item-001099")).item;
    for (const mutation of ["create", "update", "archive", "restore", "delete"] as const) {
      const before = await service.list(workspacePath, { workspacePath, paged: true, limit: 1 });
      assert.ok(before.pageInfo?.nextCursor);
      if (mutation === "create") await service.create(workspacePath, "分页验证新增记忆");
      else if (mutation === "delete")
        await service.delete(workspacePath, {
          workspacePath,
          itemId: current.itemId,
          expectedVersion: current.version,
          idempotencyKey: "page-delete",
        });
      else
        current = (
          await service.update(workspacePath, {
            workspacePath,
            itemId: current.itemId,
            expectedVersion: current.version,
            idempotencyKey: `page-${mutation}`,
            ...(mutation === "update"
              ? { content: "分页验证修改记忆" }
              : { lifecycleState: mutation === "archive" ? "archived" : "active" }),
          })
        ).item;
      await assert.rejects(
        service.list(workspacePath, {
          workspacePath,
          paged: true,
          limit: 1,
          cursor: before.pageInfo.nextCursor,
        }),
        (error: unknown) => error instanceof RuntimeProtocolError && error.code === "CONFLICT",
      );
    }
    // The original full-provenance wire shape remains intact for unpaged callers.
    const legacy = await service.list(workspacePath, { workspacePath, limit: 1 });
    assert.equal(legacy.pageInfo, undefined);
    assert.ok(Array.isArray(legacy.items[0]?.sources));
  } finally {
    service.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("TUI status uses paged counts and identifies totals as unknown for an older Host", async () => {
  for (const paged of [true, false]) {
    const calls: Array<{ method: RuntimeMethod; params: unknown }> = [];
    const runtime: RpcCommandRuntime = {
      activeSessionId: undefined,
      async request<M extends RuntimeMethod>(
        method: M,
        params: RuntimeParams<M>,
      ): Promise<RuntimeResult<M>> {
        calls.push({ method, params });
        const result =
          method === "runtime.ping"
            ? {
                capabilities: paged ? [MEMORY_PAGINATION_RUNTIME_CAPABILITY] : [],
              }
            : method === "memory.settings.get"
              ? { settings: { enabled: true, autoExtract: true, recallEnabled: true } }
              : paged
                ? {
                    items: [],
                    pageInfo: { revision: 42, counts: { active: 1200, archived: 87, total: 1287 } },
                  }
                : { items: [{ lifecycleState: "active" }, { lifecycleState: "archived" }] };
        return result as RuntimeResult<M>;
      },
    };
    const result = await createWorkspaceCommands({
      runtime,
      workspacePath: "/workspace",
    }).memory.execute(
      {
        raw: "/memory status",
        name: "memory",
        args: "status",
        argv: ["status"],
      },
      {},
    );
    assert.equal(result.type, "local");
    const message = result.type === "local" ? result.message! : "";
    if (paged) {
      assert.match(message, /Active items: 1200/u);
      assert.match(message, /Archived items: 87/u);
      assert.match(message, /Total items: 1287/u);
    } else {
      assert.match(message, /Loaded active items: 1/u);
      assert.match(message, /Loaded archived items: 1/u);
      assert.match(message, /Total items: unknown/u);
    }
    assert.deepEqual(calls.find((call) => call.method === "memory.list")?.params, {
      workspacePath: "/workspace",
      ...(paged ? { paged: true } : {}),
      limit: paged ? 1 : 50,
    });
  }
});
