import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApprovalManager } from "@pico/pico-host/global-approval-manager";
import { buildDefaultToolRegistry } from "@pico/pico-host/default-registry";
import { buildPermissionMiddleware } from "@pico/pico-host/agent-runtime";
import { WorkspaceRoots } from "@pico/pico-host/workspace-roots";
import { detectSandboxBackend } from "@pico/pico-host/process-sandbox";

const nativeWorkerAvailable = detectSandboxBackend() !== "unavailable";

for (const managed of [false, true]) {
  test(
    `write_file approval refuses changed targets through ${managed ? "managed" : "direct"} dispatch`,
    { skip: managed && !nativeWorkerAvailable },
    async (context) => {
      const root = await mkdtemp(join(tmpdir(), "pico-write-approval-bind-"));
      context.after(() => rm(root, { recursive: true, force: true }));
      const workspace = join(root, "workspace");
      await mkdir(workspace);
      const roots = WorkspaceRoots.createSync(workspace);

      const runApprovedWrite = async (
        input: { path: string; content: string },
        mutateBeforeApproval: () => Promise<void>,
        allowForSession = false,
      ) => {
        const manager = new ApprovalManager(60_000);
        const registry = buildDefaultToolRegistry(workspace, {
          workspaceRoots: roots,
          ...(managed
            ? { processSandbox: { profile: "workspace-write" as const, generation: 1 } }
            : {}),
        });
        registry.usePermission(
          buildPermissionMiddleware(
            (notice) => {
              void (async () => {
                await mutateBeforeApproval();
                if (allowForSession) {
                  manager.resolveApprovalForSession(notice.taskId, "approved for this session");
                } else {
                  manager.resolveApproval(notice.taskId, true, "approved");
                }
              })();
            },
            workspace,
            undefined,
            manager,
            {
              sessionId: `write-bind-${managed}`,
              permissionMode: "ask",
              additionalDirectories: [],
            },
            roots,
            undefined,
            undefined,
            undefined,
            () => "ask",
          ),
        );
        return registry.execute({
          id: `write-${randomUUID()}`,
          name: "write_file",
          arguments: JSON.stringify(input),
        });
      };

      const existingPath = join(workspace, "existing.txt");
      await writeFile(existingPath, "A");
      const changed = await runApprovedWrite({ path: "existing.txt", content: "C" }, () =>
        writeFile(existingPath, "B"),
      );
      assert.equal(changed.isError, true);
      assert.match(changed.output, /审批后目标状态已变化/u);
      assert.equal(await readFile(existingPath, "utf8"), "B");

      await writeFile(existingPath, "A");
      const metadataOnlyChange = await runApprovedWrite(
        { path: "existing.txt", content: "C" },
        () => chmod(existingPath, 0o600),
      );
      assert.equal(metadataOnlyChange.isError, false, metadataOnlyChange.output);
      assert.equal(await readFile(existingPath, "utf8"), "C");

      const missingPath = join(workspace, "missing.txt");
      const appeared = await runApprovedWrite(
        { path: "missing.txt", content: "C" },
        () => writeFile(missingPath, "B"),
        true,
      );
      assert.equal(appeared.isError, true);
      assert.match(appeared.output, /审批后目标状态已变化/u);
      assert.equal(await readFile(missingPath, "utf8"), "B");

      const stablePath = join(workspace, "stable.txt");
      await writeFile(stablePath, "A");
      const stable = await runApprovedWrite(
        { path: "stable.txt", content: "C" },
        async () => undefined,
        true,
      );
      assert.equal(stable.isError, false, stable.output);
      assert.equal(await readFile(stablePath, "utf8"), "C");
    },
  );
}
