import { createRoot } from "react-dom/client";
import type { RuntimeMediaReference } from "@pico/protocol";
import {
  overlayRuntimeItem,
  parseConversation,
} from "../../apps/desktop/src/renderer/conversation/runtime-projection.js";
import { ConversationTranscript } from "../../apps/desktop/src/renderer/conversation/ConversationTranscript.js";
import { SideChatWorkbarPanel } from "../../apps/desktop/src/renderer/workbar-panels/SideChatWorkbarPanel.js";
import { ArtifactPreview } from "../../apps/desktop/src/renderer/workbar-panels/ArtifactPreview.js";
import type { ConversationItemView } from "../../apps/desktop/src/renderer/conversation/types.js";
import type { MediaScope } from "../../apps/desktop/src/renderer/conversation/MediaPreview.js";
import "../../apps/desktop/src/renderer/conversation/markdown-astryx.css";
import "../../apps/desktop/src/renderer/conversation/conversation.css";
import "../../apps/desktop/src/renderer/workbar-panels/artifact-preview.css";

const root = createRoot(document.getElementById("root")!);
Object.assign(globalThis, {
  mediaFixture: {
    mount(items: ConversationItemView[], scope?: MediaScope, side = false) {
      root.render(
        side ? (
          <SideChatWorkbarPanel
            workspacePath={scope?.workspacePath}
            child={{
              panelId: "panel",
              sourceSessionId: "parent",
              targetSessionId: scope?.sessionId,
              state: "live",
            }}
            items={items}
            draft=""
            active
            running={false}
            loading={false}
            onSend={() => {}}
            onStop={() => {}}
            onDraftChange={() => {}}
            onRetryCreate={() => {}}
            onClose={() => {}}
          />
        ) : (
          <ConversationTranscript items={items} mediaScope={scope} />
        ),
      );
    },
    stream(text: string) {
      const item = overlayRuntimeItem({
        runId: "stream-run",
        turnId: "stream-turn",
        itemId: "stream-answer",
        streamId: "stream-id",
        kind: "text",
        startOffsetBytes: 0,
        endOffsetBytes: new TextEncoder().encode(text).length,
        text,
        anchorSequence: 1,
      });
      root.render(
        <ConversationTranscript
          items={parseConversation({ items: [item] }, "/fixture", "main").items}
        />,
      );
    },
    preview(reference: RuntimeMediaReference, base64: string) {
      root.render(
        <ArtifactPreview
          artifact={{
            id: reference.artifactId,
            name: reference.alt,
            mimeType: reference.mimeType,
            size: reference.sizeBytes,
            digest: reference.digest,
            createdAt: "2026-10-01",
          }}
          content={{
            artifactId: reference.artifactId,
            encoding: "base64",
            content: base64,
            offset: 0,
            nextOffset: reference.sizeBytes,
            totalSize: reference.sizeBytes,
            complete: true,
          }}
          onSave={() =>
            window.pico.artifacts.saveAs({
              workspacePath: "/fixture",
              sessionId: "preview",
              artifactId: reference.artifactId,
            })
          }
        />,
      );
    },
    clear() {
      root.render(null);
    },
  },
});
