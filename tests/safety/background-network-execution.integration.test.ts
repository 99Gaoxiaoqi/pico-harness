import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BACKGROUND_HARDLINE_VERSION,
  BACKGROUND_HOOK_VERSION,
  buildBackgroundYoloMiddleware,
  prepareBackgroundYoloPolicy,
  type BackgroundYoloPolicySnapshot,
} from "../../src/safety/background-yolo-policy.js";
import { WorkspaceRoots } from "../../src/tools/workspace-roots.js";

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
