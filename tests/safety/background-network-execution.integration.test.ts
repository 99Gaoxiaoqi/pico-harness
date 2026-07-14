import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BACKGROUND_HARDLINE_VERSION,
  BACKGROUND_HOOK_VERSION,
  buildBackgroundYoloHookExecutionMiddleware,
  buildBackgroundYoloMiddleware,
  prepareBackgroundYoloPolicy,
  type BackgroundHookRunner,
  type BackgroundYoloPolicySnapshot,
} from "../../src/safety/background-yolo-policy.js";
import { WorkspaceRoots } from "../../src/tools/workspace-roots.js";
import { HookTrustStore } from "../../src/hooks/trust/store.js";

describe("background unrestricted network execution policy integration", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("allow 放行 fetch、web_search 与 Bash 网络意图，但 hardline 仍阻断", async () => {
    const { middleware } = await fixture(policy("allow", ["fetch_url", "web_search", "bash"]));

    await expect(
      middleware({
        id: "fetch",
        name: "fetch_url",
        arguments: JSON.stringify({ url: "https://example.com/a" }),
      }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      middleware({ id: "search", name: "web_search", arguments: '{"query":"pico"}' }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      middleware({ id: "bash", name: "bash", arguments: '{"command":"curl https://example.com"}' }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      middleware({ id: "hardline", name: "bash", arguments: '{"command":"rm -rf /"}' }),
    ).resolves.toMatchObject({ allowed: false, reason: expect.stringMatching(/hardline/iu) });
  });

  it("旧 disabled/allowlist 行为保持不变，前台交互工具仍被裁剪", async () => {
    const disabled = await fixture(policy("disabled", ["fetch_url", "web_search", "bash"]));
    await expect(
      disabled.middleware({
        id: "fetch",
        name: "fetch_url",
        arguments: '{"url":"https://example.com"}',
      }),
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      disabled.middleware({ id: "bash", name: "bash", arguments: '{"command":"curl x.test"}' }),
    ).resolves.toMatchObject({ allowed: false });

    const allowlist = await fixture(
      policy("allowlist", ["fetch_url", "web_search"], ["api.example.com"]),
    );
    await expect(
      allowlist.middleware({
        id: "allowed",
        name: "fetch_url",
        arguments: '{"url":"https://api.example.com/v1"}',
      }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      allowlist.middleware({
        id: "denied",
        name: "fetch_url",
        arguments: '{"url":"https://other.example/v1"}',
      }),
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      allowlist.middleware({ id: "search", name: "web_search", arguments: '{"query":"pico"}' }),
    ).resolves.toMatchObject({ allowed: false });

    const unsafe = await fixture(policy("allow", ["schedule_task", "ask_user"]));
    expect(unsafe.prepared.allowedTools.size).toBe(0);
  });

  it("仅配置 PostToolUse 时也创建受沙箱约束的后台 runner", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pico-background-post-hook-"));
    cleanup.push(workspace);
    await mkdir(join(workspace, ".claw"), { recursive: true });
    await writeFile(
      join(workspace, ".claw", "settings.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: "read_file",
              hooks: [{ type: "command", command: "printf post > .post-hook-ran" }],
            },
          ],
        },
      }),
    );

    const prepared = await prepareBackgroundYoloPolicy({
      workDir: workspace,
      policy: policy("disabled", ["read_file"]),
      trustStore: {
        canonicalize: (path) => realpath(path),
        isTrusted: async () => true,
      },
    });

    expect(prepared.hookRunner).toBeDefined();
    await prepared.hookRunner!.runPostToolUse("read_file", { path: "a.txt" }, "content", "job-1");
    await expect(readFile(join(workspace, ".post-hook-ran"), "utf8")).resolves.toBe("post");
  });

  it("原生 .pico hooks 优先于 legacy，且命令 handler 必须先受信任", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pico-background-native-hook-"));
    const trustRoot = await mkdtemp(join(tmpdir(), "pico-background-hook-trust-"));
    cleanup.push(workspace, trustRoot);
    await mkdir(join(workspace, ".pico"), { recursive: true });
    await mkdir(join(workspace, ".claw"), { recursive: true });
    const nativePath = join(workspace, ".pico", "hooks.json");
    const handler = { type: "command" as const, command: "printf native > .native-hook-ran" };
    await writeFile(
      nativePath,
      JSON.stringify({ PostToolUse: [{ matcher: "read_file", hooks: [handler] }] }),
    );
    await writeFile(
      join(workspace, ".claw", "settings.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: "read_file",
              hooks: [{ type: "command", command: "printf legacy > .legacy-hook-ran" }],
            },
          ],
        },
      }),
    );
    const hookTrustStore = new HookTrustStore({
      filePath: join(trustRoot, "trusted-hooks.json"),
    });
    const prepare = () =>
      prepareBackgroundYoloPolicy({
        workDir: workspace,
        policy: policy("disabled", ["read_file"]),
        trustStore: {
          canonicalize: (path) => realpath(path),
          isTrusted: async () => true,
        },
        hookTrustStore,
      });

    await expect(prepare()).rejects.toMatchObject({ code: "hook_unavailable" });
    await hookTrustStore.trust({
      workspace,
      source: { kind: "project", path: nativePath, version: 1 },
      handler,
    });

    const prepared = await prepare();
    await prepared.hookRunner!.runPostToolUse("read_file", { path: "a.txt" }, "content", "job-1");
    await expect(readFile(join(workspace, ".native-hook-ran"), "utf8")).resolves.toBe("native");
    await expect(readFile(join(workspace, ".legacy-hook-ran"), "utf8")).rejects.toThrow();
  });

  it("execution middleware 在工具成功和失败后都执行 PostToolUse，不改写原结果", async () => {
    const postCalls: Array<{ toolResponse: string; toolInput: unknown }> = [];
    const hookRunner: BackgroundHookRunner = {
      async runPreToolUse() {
        return { decision: "allow" };
      },
      async runPostToolUse(_toolName, toolInput, toolResponse) {
        postCalls.push({ toolInput, toolResponse });
      },
    };
    const middleware = buildBackgroundYoloHookExecutionMiddleware({
      policy: { hookRunner },
      sessionId: "background-post-test",
    });
    const call = { id: "read", name: "read_file", arguments: '{"path":"a.txt"}' };

    await expect(middleware(call, async () => "tool-ok")).resolves.toBe("tool-ok");
    const failure = new Error("tool-failed");
    await expect(
      middleware(call, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(postCalls).toEqual([
      { toolInput: { path: "a.txt" }, toolResponse: "tool-ok" },
      { toolInput: { path: "a.txt" }, toolResponse: "[tool_error] tool-failed" },
    ]);
  });

  async function fixture(snapshot: BackgroundYoloPolicySnapshot) {
    const workspace = await mkdtemp(join(tmpdir(), "pico-background-network-"));
    cleanup.push(workspace);
    const prepared = await prepareBackgroundYoloPolicy({
      workDir: workspace,
      policy: snapshot,
      trustStore: {
        canonicalize: (path) => realpath(path),
        isTrusted: async () => true,
      },
    });
    const roots = await WorkspaceRoots.create(workspace, []);
    return {
      prepared,
      middleware: buildBackgroundYoloMiddleware({
        policy: prepared,
        workspaceRoots: roots,
        sessionId: "background-network-test",
      }),
    };
  }
});

function policy(
  toolNetworkPolicy: BackgroundYoloPolicySnapshot["toolNetworkPolicy"],
  allowedTools: string[],
  allowedToolNetworkHosts?: string[],
): BackgroundYoloPolicySnapshot {
  return {
    mode: "yolo",
    backgroundEnabled: true,
    trustedWorkspace: true,
    toolNetworkPolicy,
    ...(allowedToolNetworkHosts ? { allowedToolNetworkHosts } : {}),
    allowedTools,
    hardlineVersion: BACKGROUND_HARDLINE_VERSION,
    hookVersion: BACKGROUND_HOOK_VERSION,
    createdAt: Date.now(),
  };
}
