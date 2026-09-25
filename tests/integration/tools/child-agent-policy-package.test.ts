import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildChildAgentSafetyMiddleware,
  createChildAgentToolConstructors,
  createHookVerifierRegistry,
} from "@pico/pico-host/child-agent-policy";
import { ToolRegistry } from "@pico/pico-host/tool-registry";
import { WorkspaceRoots, buildWorkspaceBoundaryMiddleware } from "@pico/pico-host/workspace-roots";

test("Host child tools and Hook verifier preserve isolated read-only boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-child-policy-package-"));
  try {
    const workDir = join(root, "workspace");
    await mkdir(workDir);
    await writeFile(join(workDir, "evidence.txt"), "CHILD_POLICY_EVIDENCE");
    await writeFile(join(workDir, ".env"), "SECRET=hidden");
    await writeFile(join(root, "outside.txt"), "OUTSIDE_SECRET");
    for (const folder of ["first", "second"]) {
      const skillDir = join(workDir, ".pico", "skills", folder);
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        "---\nname: child-policy-probe\ndescription: Package fixture\n---\nSKILL_POLICY_EVIDENCE",
      );
    }
    const workspaceRoots = await WorkspaceRoots.create(workDir);
    const registryLogs: string[] = [];
    const skillLogs: string[] = [];
    const grepLogs: string[] = [];
    const grepDiagnostics = {
      warn: (_bindings: unknown, message: string) => {
        grepLogs.push(message);
      },
      debug: (_bindings: unknown, message: string) => {
        grepLogs.push(message);
      },
    };
    const options = { workDir, workspaceRoots, processSandbox: {}, env: {} };
    const verifier = createHookVerifierRegistry({
      ...options,
      diagnostics: {
        info: (context, message) => {
          registryLogs.push(message ?? String(context));
        },
        warn: (context, message) => {
          registryLogs.push(message ?? String(context));
        },
      },
      skillLogger: {
        warn: (_bindings, message) => {
          skillLogs.push(message);
        },
        debug: (_bindings, message) => {
          skillLogs.push(message);
        },
      },
      grepDiagnostics,
    });
    assert.ok(registryLogs.some((message) => message.includes("read_file")));
    for (const name of ["read_file", "skill_view", "bash", "glob", "grep"]) {
      assert.equal(verifier.isReadOnlyTool(name), true, name);
    }
    for (const name of ["write_file", "edit_file", "web_search"]) {
      assert.equal(verifier.getTool(name), undefined, name);
    }
    const execute = (name: string, args: Record<string, unknown>) =>
      verifier.execute({ id: `${name}-probe`, name, arguments: JSON.stringify(args) });
    assert.match(
      (await execute("read_file", { path: "evidence.txt" })).output,
      /CHILD_POLICY_EVIDENCE/,
    );
    const skill = await execute("skill_view", { name: "child-policy-probe" });
    assert.equal(skill.isError, true);
    assert.match(skill.output, /sandbox_unavailable/u);
    assert.deepEqual(skillLogs, []);
    await execute("grep", { path: "evidence.txt", pattern: "probe", max_files: 1 });
    assert.deepEqual(grepLogs, []);

    for (const [name, args] of [
      ["read_file", { path: "../outside.txt" }],
      ["read_file", { path: ".env" }],
      ["grep", { path: ".env", pattern: "SECRET" }],
      ["bash", { command: "echo changed > evidence.txt" }],
      ["bash", { command: "curl https://example.com" }],
    ] as const) {
      assert.equal((await execute(name, args)).isError, true, `${name}: ${JSON.stringify(args)}`);
    }
    assert.equal(await readFile(join(workDir, "evidence.txt"), "utf8"), "CHILD_POLICY_EVIDENCE");

    const constructors = createChildAgentToolConstructors(grepDiagnostics);
    assert.deepEqual(Object.keys(constructors).sort(), [
      "bash",
      "edit_file",
      "glob",
      "grep",
      "read_file",
      "web_search",
      "write_file",
    ]);
    const child = new ToolRegistry();
    child.register(constructors.read_file!(workDir, workspaceRoots));
    child.useSafety(buildChildAgentSafetyMiddleware("explore", options));
    child.useSafety(buildWorkspaceBoundaryMiddleware(workspaceRoots));
    const read = await child.execute({
      id: "child-read",
      name: "read_file",
      arguments: '{"path":"evidence.txt"}',
    });
    assert.match(read.output, /CHILD_POLICY_EVIDENCE/);
    await constructors.grep!(workDir, workspaceRoots).execute(
      '{"path":"evidence.txt","pattern":"probe","max_files":1}',
    );
    assert.equal(grepLogs.length, 0);
    assert.ok(createHookVerifierRegistry(options) instanceof ToolRegistry);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
