import "../../apps/desktop/src/renderer/layers.css";
import { ChatLayout } from "@astryxdesign/core/Chat";
import { Button } from "@astryxdesign/core/Button";
import { Cpu, Folder } from "lucide-react";
import { SelectField } from "../../apps/desktop/src/renderer/ui-controls.js";
import type { ComposerStatus } from "../../apps/desktop/src/renderer/conversation/types.js";
import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { RuntimeContext } from "../../apps/desktop/src/renderer/runtime-context.js";
import { WorkspaceRoute } from "../../apps/desktop/src/renderer/workspace-access.js";
import { useRuntimeStore, type RuntimeStore } from "../../apps/desktop/src/renderer/runtime.js";
import { PicoTheme } from "../../apps/desktop/src/renderer/astryx-provider.js";
import {
  ConversationComposer,
  type ConversationComposerHandle,
} from "../../apps/desktop/src/renderer/conversation/ConversationComposer.js";
import { ConversationSurface } from "../../apps/desktop/src/renderer/conversation/ConversationSurface.js";
import { SideChatWorkbarPanel } from "../../apps/desktop/src/renderer/workbar-panels/SideChatWorkbarPanel.js";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/astryx-controls.css";
import "../../apps/desktop/src/renderer/pages-astryx.css";
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
  mountRuntimeComposer: () => void;
  finishSend: (success: boolean) => void;
  failRefresh: () => void;
  refreshStarted: boolean;
  runtimeMessage: string | undefined;
  setStatus: (status: ComposerStatus) => void;
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
  const [status, setStatus] = useState<ComposerStatus>("idle");
  host.setStatus = setStatus;
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
              status={status}
              onBehaviorChange={() => {}}
              onPause={() => setStatus("paused")}
              onResume={() => setStatus("running")}
              onStop={() => setStatus("idle")}
              leadingAccessory={
                status !== "idle" && (
                  <>
                    <span className="conversation-context-label">
                      <Folder />
                      <span>无项目</span>
                    </span>
                    <Button
                      className="composer-model-trigger pico-page-control"
                      variant="ghost"
                      isDisabled
                      label="模型"
                    >
                      <Cpu className="composer-model-mark" />
                      <span>gpt-5.6-luna-fast</span>
                    </Button>
                    <span className="conversation-context-gauge">上下文未知</span>
                    <div className="conversation-context-option">
                      <SelectField
                        label="权限模式"
                        disabled
                        value="full-access"
                        onValueChange={() => {}}
                        options={[{ value: "full-access", label: "权限：完全访问权限" }]}
                      />
                    </div>
                  </>
                )
              }
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
function RuntimeSendFixture() {
  const runtime = useRuntimeStore();
  return (
    <PicoTheme>
      <RuntimeContext value={runtime}>
        <MemoryRouter>
          <Routes>
            <Route path="/" element={<RuntimeSendComposer runtime={runtime} />} />
            <Route
              path="/session/:sessionId"
              element={
                <WorkspaceRoute>
                  <RuntimeSendComposer runtime={runtime} />
                </WorkspaceRoute>
              }
            />
          </Routes>
        </MemoryRouter>
      </RuntimeContext>
    </PicoTheme>
  );
}
function RuntimeSendComposer({ runtime }: { runtime: RuntimeStore }) {
  const navigate = useNavigate();
  const [draft, setDraft] = useState("");
  host.draft = draft;
  host.runtimeMessage = runtime.message;
  return (
    <PicoTheme>
      <ConversationComposer
        value={draft}
        onValueChange={setDraft}
        status="idle"
        busy={Boolean(runtime.busy)}
        onSubmit={async ({ text }) => {
          const workspacePath = await runtime.actions.ensureTemporaryWorkspace();
          if (!workspacePath) return;
          const result = await runtime.actions.sendMessage({
            workspacePath,
            sessionId: "fixture-session",
            text,
          });
          if (result.succeeded) {
            setDraft("");
            navigate("/session/fixture-session?workspace=%2Ffixture");
          }
        }}
      />
    </PicoTheme>
  );
}
const root = createRoot(document.getElementById("root")!);
host.mountRuntimeComposer = () => {
  // Keep post-send hydration pending, as session inspection can wait behind a run.
  window.pico = {
    runtime: {
      "runtime.ping": async () => {
        throw new Error("isolated send fixture");
      },
      "workspace.temporary.ensure": async () => ({
        ok: true,
        value: {
          workspacePath: "/fixture",
          temporary: true,
          registered: true,
          mode: "folder",
          branch: "",
          capabilities: {
            foregroundRuns: true,
            fileHistory: false,
            isolatedWorktrees: false,
            branchMerge: false,
          },
        },
      }),
      "session.send": () =>
        new Promise((resolve) => {
          host.finishSend = (success) =>
            resolve(
              success
                ? { ok: true, value: { session: { sessionId: "fixture-session" } } }
                : {
                    ok: false,
                    error: { code: "CONFLICT", message: "发送被拒绝", retryable: false },
                  },
            );
        }),
      "workspace.status": () =>
        new Promise((_resolve, reject) => {
          host.refreshStarted = true;
          host.failRefresh = () => reject(new Error("刷新暂不可用"));
        }),
    },
    onUnavailable: () => () => {},
    onRecovered: () => () => {},
  } as unknown as NonNullable<typeof window.pico>;
  root.render(<RuntimeSendFixture />);
};
root.render(<Fixture />);
