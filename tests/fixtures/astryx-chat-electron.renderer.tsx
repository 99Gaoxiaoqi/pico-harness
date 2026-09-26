import "../../apps/desktop/src/renderer/layers.css";
import { ChatLayout } from "@astryxdesign/core/Chat";
import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";
import { PicoTheme } from "../../apps/desktop/src/renderer/astryx-provider.js";
import {
  ConversationComposer,
  type ConversationComposerHandle,
} from "../../apps/desktop/src/renderer/conversation/ConversationComposer.js";
import { ConversationSurface } from "../../apps/desktop/src/renderer/conversation/ConversationSurface.js";
import { SideChatWorkbarPanel } from "../../apps/desktop/src/renderer/workbar-panels/SideChatWorkbarPanel.js";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/astryx-controls.css";
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
  disabledScrollWrites: number[];
};
host.disabledScrollWrites = [];
const scrollTop = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
Object.defineProperty(Element.prototype, "scrollTop", {
  ...scrollTop,
  set(value: number) {
    if (this.classList.contains("disabled-scroll-probe")) host.disabledScrollWrites.push(value);
    scrollTop.set!.call(this, value);
  },
});
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
    <PicoTheme>
      <ChatLayout
        className="disabled-scroll-probe"
        scrollButton={null}
        autoScroll={false}
        style={{ position: "fixed", left: -1000, width: 120, height: "25vh" }}
      >
        {Array.from({ length: count }, (_, index) => (
          <p key={index} style={{ height: 32 }}>
            消息 {index}
          </p>
        ))}
      </ChatLayout>
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
    </PicoTheme>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
