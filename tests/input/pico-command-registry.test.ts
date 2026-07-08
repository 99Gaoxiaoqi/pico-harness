import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Session } from "../../src/engine/session.js";
import {
  fileHistoryMakeSnapshot,
  fileHistoryTrackEdit,
} from "../../src/safety/file-history.js";
import { createBuiltinCommandRegistry } from "../../src/input/builtin-commands.js";
import { createPicoCommandRegistry } from "../../src/input/pico-command-registry.js";
import { processUserInput } from "../../src/input/process-user-input.js";

describe("Pico command registry", () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    while (cleanup.length > 0) {
      cleanup.pop()?.();
    }
  });

  async function registryWithSnapshot(messageId = "turn-1") {
    const workDir = mkdtempSync(join(tmpdir(), "pico-command-rewind-"));
    const session = new Session(`pico-command-${Date.now()}-${Math.random()}`, workDir, {
      persistence: false,
    });
    const filePath = join(workDir, "note.txt");
    writeFileSync(filePath, "before\n");
    session.append({ role: "user", content: "edit" });
    session.append({ role: "assistant", content: "done" });
    await fileHistoryTrackEdit(session.fileHistory, filePath, messageId, session.id);
    writeFileSync(filePath, "after\n");
    await fileHistoryMakeSnapshot(
      session.fileHistory,
      messageId,
      session.id,
      undefined,
      session.length,
    );
    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "glm-5.2",
      session,
    });
    cleanup.push(() => {
      session.close();
      rmSync(workDir, { recursive: true, force: true });
    });
    return { registry, filePath };
  }

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

  it("/snapshots 展示当前 session 可回滚点", async () => {
    const { registry } = await registryWithSnapshot("turn-1");

    const result = await processUserInput("/snapshots", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("snapshots");
    expect(result.result.message).toContain("turn-1");
    expect(result.result.message).toContain("/rewind turn-1");
  });

  it("/rewind <message-id> 接到既有文件历史回滚", async () => {
    const { registry, filePath } = await registryWithSnapshot("turn-1");

    const result = await processUserInput("/rewind turn-1 code", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.result.message).toContain("已回滚");
    expect(readFileSync(filePath, "utf8")).toBe("before\n");
  });

  it("/undo 默认回滚最后一个文件历史快照", async () => {
    const { registry, filePath } = await registryWithSnapshot("turn-2");

    const result = await processUserInput("/undo", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("undo");
    expect(result.result.message).toContain("turn-2");
    expect(readFileSync(filePath, "utf8")).toBe("before\n");
  });
});
