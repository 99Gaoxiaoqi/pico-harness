import assert from "node:assert/strict";
import test from "node:test";
import { ToolRegistry, createToolRegistrationOwner } from "@pico/pico-host/tool-registry";
import {
  ToolRegistry as ProductToolRegistry,
  createToolRegistrationOwner as createProductOwner,
} from "@pico/pico-host/product-tool-registry";

test("Host ToolRegistry executes registered tools and its product factory preserves owner identity", async () => {
  assert.equal(createProductOwner, createToolRegistrationOwner);
  const diagnostics: string[] = [];
  const registry = new ToolRegistry(undefined, {
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
  assert.equal(
    (await registry.execute({ id: "probe", name: "package_probe", arguments: "{}" })).output,
    "ok",
  );
  assert.ok(new ProductToolRegistry() instanceof ToolRegistry);
});
