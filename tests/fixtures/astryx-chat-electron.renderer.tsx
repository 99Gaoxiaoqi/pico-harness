import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import {
  ConversationComposer,
  type ConversationComposerHandle,
} from "../../apps/desktop/src/renderer/conversation/ConversationComposer.js";
import { ConversationSurface } from "../../apps/desktop/src/renderer/conversation/ConversationSurface.js";
import { SideChatWorkbarPanel } from "../../apps/desktop/src/renderer/workbar-panels/SideChatWorkbarPanel.js";
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "@astryxdesign/theme-neutral/theme.css";
import "../../apps/desktop/src/renderer/conversation/conversation.css";
import "../../apps/desktop/src/renderer/workbar-panels/ToolPanels.css";
import "../../apps/desktop/src/renderer/conversation/astryx-chat.css";

const host = window as unknown as {
  draft: string;
  sideDraft: string;
  sent: string[];
  sideSent: string[];
  clearOnSend: boolean;
  setDraft: (text: string) => void;
  append: () => void;
  focusEditor: () => void;
};
host.sent = [];
host.sideSent = [];
host.clearOnSend = false;
function Fixture() {
  const [draft, setDraft] = useState("第一行\n第二行");
  const [sideDraft, setSideDraft] = useState("侧聊草稿");
  const [count, setCount] = useState(60);
  const [plan, setPlan] = useState(false);
  const inputRef = useRef<ConversationComposerHandle>(null);
  host.draft = draft;
  host.sideDraft = sideDraft;
  host.setDraft = setDraft;
  host.append = () => setCount((value) => value + 1);
  host.focusEditor = () => inputRef.current?.focus();
  return (
    <Theme theme={neutralTheme} mode="light">
      <main
        style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 300px", height: "100vh" }}
      >
        <ConversationSurface
          composer={
            <ConversationComposer
              value={draft}
              onValueChange={setDraft}
              inputRef={inputRef}
              status="idle"
              onSubmit={({ text }) => {
                host.sent.push(text);
                if (host.clearOnSend) setDraft("");
              }}
              modes={{
                planActive: plan,
                graphActive: false,
                onPlanChange: setPlan,
                onGraphChange: () => {},
              }}
            />
          }
        >
          {Array.from({ length: count }, (_, index) => (
            <p key={index} style={{ minHeight: 32, margin: 8 }}>
              消息 {index}
            </p>
          ))}
        </ConversationSurface>
        <SideChatWorkbarPanel
          child={{
            panelId: "side",
            sourceSessionId: "main",
            targetSessionId: "child",
            state: "live",
          }}
          items={[]}
          draft={sideDraft}
          active
          running={false}
          loading={false}
          onSend={(text) => host.sideSent.push(text)}
          onDraftChange={setSideDraft}
          onStop={() => {}}
          onRetryCreate={() => {}}
          onClose={() => {}}
        />
      </main>
    </Theme>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
