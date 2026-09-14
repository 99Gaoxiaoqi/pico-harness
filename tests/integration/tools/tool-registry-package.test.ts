import assert from "node:assert/strict";
import test from "node:test";
import {
  ToolRegistry as PackageToolRegistry,
  createToolRegistrationOwner as createPackageOwner,
} from "@pico/pico-host/tool-registry";
import {
  ToolRegistry as LegacyToolRegistry,
  createToolRegistrationOwner as createLegacyOwner,
} from "../../../src/tools/registry-impl.js";
import { ReadFileTool as PackageReadFileTool } from "@pico/pico-host/read-file-tool";
import { WriteFileTool as PackageWriteFileTool } from "@pico/pico-host/write-file-tool";
import { EditFileTool as PackageEditFileTool } from "@pico/pico-host/edit-file-tool";
import { ReadFileTool as LegacyReadFileTool } from "../../../src/tools/read-file.js";
import { WriteFileTool as LegacyWriteFileTool } from "../../../src/tools/write-file.js";
import { EditFileTool as LegacyEditFileTool } from "../../../src/tools/edit-file.js";
import {
  FetchURLTool as PackageFetchURLTool,
  WebSearchTool as PackageWebSearchTool,
} from "@pico/pico-host/web-tools";
import {
  FetchURLTool as LegacyFetchURLTool,
  WebSearchTool as LegacyWebSearchTool,
} from "../../../src/tools/web.js";
import { BackgroundManager as PackageBackgroundManager } from "@pico/pico-host/background-manager";
import { BackgroundManager as LegacyBackgroundManager } from "../../../src/tools/background-manager.js";
import { createCodeIntelligenceTools as createPackageCodeIntelligenceTools } from "@pico/pico-host/code-intelligence-tools";
import { createCodeIntelligenceTools as createLegacyCodeIntelligenceTools } from "../../../src/tools/code-intelligence.js";
import { GlobTool as PackageGlobTool } from "@pico/pico-host/glob-tool";
import { GlobTool as LegacyGlobTool } from "../../../src/tools/glob.js";
import { observeWorkspaceFileScans as observePackageWorkspaceFileScans } from "@pico/runtime/file-scan-observer";
import { observeWorkspaceFileScans as observeLegacyWorkspaceFileScans } from "../../../src/tools/file-scan-observer.js";
import { GrepTool as PackageGrepTool } from "@pico/pico-host/grep-tool";
import { GrepTool as LegacyGrepTool } from "../../../src/tools/grep.js";
import { BashTool as PackageBashTool } from "@pico/pico-host/bash-tool";
import { BashTool as LegacyBashTool } from "../../../src/tools/bash.js";
import { evaluateSandboxCommand as evaluatePackageSandboxCommand } from "@pico/pico-host/workspace-sandbox";
import { evaluateSandboxCommand as evaluateLegacySandboxCommand } from "../../../src/safety/workspace-sandbox.js";
import { HttpMcpClient as PackageHttpMcpClient } from "@pico/pico-host/http-mcp-client";
import { StdioMcpClient as PackageStdioMcpClient } from "@pico/pico-host/stdio-mcp-client";
import { McpToolBridge as PackageMcpToolBridge } from "@pico/pico-host/mcp-tool";
import { McpConnectionManager as PackageMcpConnectionManager } from "@pico/pico-host/mcp-connection-manager";
import { HttpMcpClient as LegacyHttpMcpClient } from "../../../src/mcp/http-client.js";
import { StdioMcpClient as LegacyStdioMcpClient } from "../../../src/mcp/stdio-client.js";
import { McpToolBridge as LegacyMcpToolBridge } from "../../../src/mcp/mcp-tool.js";
import { McpConnectionManager as LegacyMcpConnectionManager } from "../../../src/mcp/manager.js";

test("ToolRegistry package owns the implementation while the legacy entry preserves composition", () => {
  assert.equal(createLegacyOwner, createPackageOwner);

  const diagnostics: string[] = [];
  const registry = new PackageToolRegistry(undefined, {
    info: (_context, message) => diagnostics.push(message ?? String(_context)),
    warn: (_context, message) => diagnostics.push(message ?? String(_context)),
  });
  registry.register({
    name: () => "package_probe",
    definition: () => ({
      name: "package_probe",
      description: "package boundary probe",
      inputSchema: { type: "object", additionalProperties: false },
    }),
    execute: async () => "ok",
    readOnly: true,
  });

  assert.equal(registry.getTool("package_probe")?.name(), "package_probe");
  assert.equal(diagnostics.length, 1);
  assert.ok(new LegacyToolRegistry() instanceof PackageToolRegistry);
});

test("file tool compatibility entries preserve package implementation identity", () => {
  assert.equal(LegacyReadFileTool, PackageReadFileTool);
  assert.equal(LegacyWriteFileTool, PackageWriteFileTool);
  assert.equal(LegacyEditFileTool, PackageEditFileTool);
});

test("web tool compatibility entry preserves package implementation identity", () => {
  assert.equal(LegacyFetchURLTool, PackageFetchURLTool);
  assert.equal(LegacyWebSearchTool, PackageWebSearchTool);
});

test("background manager compatibility entry preserves package implementation identity", () => {
  assert.equal(LegacyBackgroundManager, PackageBackgroundManager);
});

test("code intelligence tool compatibility entry preserves package factory identity", () => {
  assert.equal(createLegacyCodeIntelligenceTools, createPackageCodeIntelligenceTools);
});

test("glob and file-scan compatibility entries preserve package identities", () => {
  assert.equal(LegacyGlobTool, PackageGlobTool);
  assert.equal(observeLegacyWorkspaceFileScans, observePackageWorkspaceFileScans);
});

test("legacy grep diagnostics adapter is a Pico Host GrepTool", () => {
  assert.ok(new LegacyGrepTool(process.cwd()) instanceof PackageGrepTool);
});

test("bash and workspace sandbox compatibility entries preserve package identities", () => {
  assert.equal(LegacyBashTool, PackageBashTool);
  assert.equal(evaluateLegacySandboxCommand, evaluatePackageSandboxCommand);
});

test("legacy MCP adapters inherit the Pico Host transport and lifecycle implementations", () => {
  assert.ok(LegacyHttpMcpClient.prototype instanceof PackageHttpMcpClient);
  assert.ok(LegacyStdioMcpClient.prototype instanceof PackageStdioMcpClient);
  assert.ok(LegacyMcpToolBridge.prototype instanceof PackageMcpToolBridge);
  assert.ok(LegacyMcpConnectionManager.prototype instanceof PackageMcpConnectionManager);
});
