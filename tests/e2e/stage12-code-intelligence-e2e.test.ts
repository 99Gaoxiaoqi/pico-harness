import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { CodeIntelligenceManager } from "../../src/code-intelligence/code-intelligence-manager.js";
import { buildDefaultToolRegistry } from "../../src/tools/default-registry.js";
import { ToolDisclosure } from "../../src/tools/tool-disclosure.js";

const fixtureServer = fileURLToPath(new URL("./fixtures/mock-lsp-server.mjs", import.meta.url));

it("Stage 12 代码智能在真实临时仓库中完成 LSP 导航并确定性降级 Repo Map", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "pico-stage12-code-intelligence-"));
  const sourcePath = path.join(workDir, "index.ts");
  const source = [
    "export function greet(name: string) { return `hello ${name}`; }",
    'export const message = greet("pico");',
    "",
  ].join("\n");

  try {
    await writeFile(sourcePath, source, "utf8");
    await writeFile(
      path.join(workDir, "tsconfig.json"),
      '{"compilerOptions":{"strict":true}}',
      "utf8",
    );

    const lspManager = new CodeIntelligenceManager({
      rootDir: workDir,
      pathEnv: "",
      lspServers: [{ id: "integration-lsp", command: process.execPath, args: [fixtureServer] }],
    });
    const [firstStart, secondStart] = await Promise.all([lspManager.start(), lspManager.start()]);
    expect(firstStart).toEqual(secondStart);
    expect(firstStart).toMatchObject({ backend: "lsp", serverId: "integration-lsp" });

    const lsp = lspManager.service();
    expect(lsp?.backend).toBe("lsp");
    await expect(
      lsp?.definitions({ filePath: "index.ts", position: { line: 2, character: 24 } }),
    ).resolves.toMatchObject([
      {
        filePath: sourcePath,
        range: { start: { line: 1, character: 17 }, end: { line: 1, character: 22 } },
      },
    ]);
    await expect(lsp?.diagnostics("index.ts")).resolves.toMatchObject([
      { severity: "warning", source: "mock-lsp", message: "integration diagnostic" },
    ]);
    await lspManager.close();

    const fallbackManager = new CodeIntelligenceManager({ rootDir: workDir, pathEnv: "" });
    await expect(fallbackManager.start()).resolves.toMatchObject({ backend: "repo-map" });
    const repoMap = fallbackManager.service();
    expect(repoMap?.backend).toBe("repo-map");
    await expect(repoMap?.symbols({ query: "greet" })).resolves.toMatchObject([
      { name: "greet", kind: "function" },
    ]);
    await expect(
      repoMap?.definitions({ filePath: "index.ts", position: { line: 2, character: 24 } }),
    ).resolves.toMatchObject([{ filePath: sourcePath }]);
    await writeFile(
      sourcePath,
      `${source}export function wave() { return greet("again"); }\n`,
      "utf8",
    );
    await expect(repoMap?.symbols({ query: "wave", filePath: "index.ts" })).resolves.toMatchObject([
      { name: "wave", kind: "function" },
    ]);

    const disclosure = new ToolDisclosure();
    const registry = buildDefaultToolRegistry(workDir, {
      toolDisclosure: disclosure,
      codeIntelligence: repoMap,
    });
    expect(
      disclosure.pickForLLM(registry.getAvailableTools()).map((tool) => tool.name),
    ).not.toContain("repo_map");
    const search = await registry.execute({
      id: "search-code-tools",
      name: "search_tools",
      arguments: JSON.stringify({ query: "仓库 符号 代码" }),
    });
    expect(search.isError).toBe(false);
    expect(disclosure.getDisclosed()).toEqual(
      expect.arrayContaining(["repo_map", "code_symbols", "code_definition"]),
    );
    const map = await registry.execute({
      id: "repo-map",
      name: "repo_map",
      arguments: JSON.stringify({ max_files: 10 }),
    });
    expect(map).toMatchObject({ isError: false });
    expect(map.output).toContain("index.ts: function greet, variable message");
    expect(map.output).toContain("complete=true");
    await fallbackManager.close();
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
