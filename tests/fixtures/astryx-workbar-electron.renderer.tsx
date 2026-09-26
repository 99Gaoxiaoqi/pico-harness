import { createRoot } from "react-dom/client";
import { useState } from "react";
import { PicoTheme } from "../../apps/desktop/src/renderer/astryx-provider.js";
import { TasksWorkbarPanel } from "../../apps/desktop/src/renderer/workbar-panels/TasksWorkbarPanel.js";
import { FilesWorkbarPanel } from "../../apps/desktop/src/renderer/workbar-panels/FilesWorkbarPanel.js";
import { BrowserWorkbarPanel } from "../../apps/desktop/src/renderer/workbar-panels/BrowserWorkbarPanel.js";
import { TerminalWorkbarPanel } from "../../apps/desktop/src/renderer/workbar-panels/TerminalWorkbarPanel.js";
import type { DesktopBridge } from "../../apps/desktop/src/preload/contract.js";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/workbar-panels/ToolPanels.css";
import "../../apps/desktop/src/renderer/workbar-panels/workbar-panels.css";
import "../../apps/desktop/src/renderer/astryx-controls.css";
import "../../apps/desktop/src/renderer/workbar/workbar-astryx.css";
const host = window as unknown as { mode: (value: string) => void; calls: unknown[][] };
host.calls = [];
const record =
  (name: string) =>
  (...args: unknown[]) => {
    host.calls.push([name, ...args]);
  };
const browserState = {
  sessionId: "s",
  url: "https://example.com",
  canGoBack: false,
  canGoForward: false,
  hasPage: false,
};
const bridge = {
  browser: {
    onState: () => () => {},
    getState: async () => ({ ok: true, value: browserState }),
    navigate: async (...args: unknown[]) => {
      host.calls.push(["navigate", ...args]);
      return { ok: true, value: browserState };
    },
  },
} as unknown as DesktopBridge;
const artifact = {
  id: "a",
  name: "report.html",
  mimeType: "text/html",
  size: 20,
  createdAt: "2026-01-01T00:00:00Z",
};
function Fixture() {
  const [mode, setMode] = useState("tasks");
  host.mode = setMode;
  return (
    <PicoTheme>
      <main style={{ width: 420, height: "100vh" }}>
        {mode === "tasks" ? (
          <TasksWorkbarPanel
            ledger={{
              revision: 7,
              tasks: [{ id: "task", title: "待验证任务", revision: 3, status: "pending" }],
            }}
            loading={false}
            onRefresh={record("refresh")}
            onCreate={record("create")}
            onUpdate={record("update")}
          />
        ) : mode === "browser" ? (
          <BrowserWorkbarPanel bridge={bridge} sessionId="s" active={false} />
        ) : mode === "terminal" ? (
          <TerminalWorkbarPanel
            terminals={[
              {
                id: "t",
                title: "Shell",
                status: "running",
                attached: true,
                sequence: 1,
                capability: "pipe",
                resizeSupported: false,
              },
            ]}
            activeTerminalId="t"
            active={false}
            loading={false}
            onCreate={record("terminal-create")}
            onSelect={record("terminal-select")}
            onAttach={record("attach")}
            onInput={record("input")}
            onResize={record("resize")}
            onStop={record("stop")}
            onSetPollingActive={() => {}}
          />
        ) : (
          <FilesWorkbarPanel
            artifacts={[artifact]}
            selectedArtifactId="a"
            loading={false}
            onRefresh={() => {}}
            onSelectArtifact={() => {}}
            onBack={() => {}}
            onLoadChunk={() => {}}
            onOpenDefaultApp={record("open")}
            onOpenArtifact={record("reveal")}
            onSaveArtifactAs={record("save")}
          />
        )}
      </main>
    </PicoTheme>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
