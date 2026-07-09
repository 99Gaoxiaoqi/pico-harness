import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import {
  createLocalUiDialogRequest,
  type LocalUiDialogHostContext,
} from "../../src/tui/local-ui-dialog-host.js";

const context: LocalUiDialogHostContext = {
  commands: [
    {
      name: "help",
      description: "Show slash command help",
      kind: "local",
      source: "builtin",
    },
  ],
  models: [
    {
      id: "gpt-5",
      name: "GPT-5",
      description: "Default model",
    },
  ],
  currentModelId: "gpt-5",
  sessions: [
    {
      id: "session-1",
      cwd: "/workspace/demo",
      messageCount: 3,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:10:00Z"),
      title: "Previous work",
    },
  ],
  currentProjectCwd: "/workspace/demo",
  rewindSessionId: "session-1",
  rewindSnapshots: [
    {
      messageId: "turn-1",
      messageIndex: 1,
      checkpointDir: "/tmp/turn-1",
      createdAt: new Date("2026-01-01T00:05:00Z"),
      trackedFileCount: 1,
      totalBytes: 128,
      changeSummary: "updated src/index.ts",
    },
  ],
};

describe("createLocalUiDialogRequest", () => {
  it("returns null for unknown or invalid UI actions", () => {
    expect(createLocalUiDialogRequest(undefined, context)).toBeNull();
    expect(createLocalUiDialogRequest({ kind: "open-panel", panel: "unknown" }, context)).toBeNull();
    expect(
      createLocalUiDialogRequest({ kind: "open-selector", selector: "unknown" }, context),
    ).toBeNull();
  });

  it("maps the help panel action to an overlay dialog", () => {
    const request = createLocalUiDialogRequest({ kind: "open-panel", panel: "help" }, context);

    expect(request).toMatchObject({
      id: "local-ui:help",
      layer: "overlay",
      priority: 30,
    });
    expect(renderToString(request?.content)).toContain("Slash commands");
    expect(renderToString(request?.content)).toContain("/help");
  });

  it("maps the model selector action to a modal dialog", () => {
    const request = createLocalUiDialogRequest(
      { kind: "open-selector", selector: "model" },
      context,
    );

    expect(request).toMatchObject({
      id: "local-ui:model-selector",
      layer: "modal",
      priority: 40,
    });
    expect(renderToString(request?.content)).toContain("Models");
    expect(renderToString(request?.content)).toContain("GPT-5 [current]");
  });

  it("maps the session selector action to a modal dialog", () => {
    const request = createLocalUiDialogRequest(
      { kind: "open-selector", selector: "session" },
      context,
    );

    expect(request).toMatchObject({
      id: "local-ui:session-selector",
      layer: "modal",
      priority: 40,
    });
    expect(renderToString(request?.content)).toContain("Sessions [cwd]");
    expect(renderToString(request?.content)).toContain("Previous work");
  });

  it("maps the rewind selector action to a modal dialog", () => {
    const request = createLocalUiDialogRequest(
      { kind: "open-selector", selector: "rewind" },
      context,
    );

    expect(request).toMatchObject({
      id: "local-ui:rewind-selector",
      layer: "modal",
      priority: 40,
    });
    expect(renderToString(request?.content)).toContain("Rewind");
    expect(renderToString(request?.content)).toContain("turn-1");
  });
});
