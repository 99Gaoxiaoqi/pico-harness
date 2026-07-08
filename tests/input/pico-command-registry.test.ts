import { describe, expect, it } from "vitest";
import { createBuiltinCommandRegistry } from "../../src/input/builtin-commands.js";
import { createPicoCommandRegistry } from "../../src/input/pico-command-registry.js";
import { processUserInput } from "../../src/input/process-user-input.js";

describe("Pico command registry", () => {
  it("/mode is accepted as an alias for the current model command", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
    });

    const result = await processUserInput("/mode", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("model");
    expect(result.result.action).toBe("model");
    expect(result.result.message).toContain("glm-5.2");
  });

  it("builtin registry also accepts /mode as a model alias", async () => {
    const result = await processUserInput("/mode", {
      registry: createBuiltinCommandRegistry(),
    });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("model");
    expect(result.result.action).toBe("model");
  });
});
