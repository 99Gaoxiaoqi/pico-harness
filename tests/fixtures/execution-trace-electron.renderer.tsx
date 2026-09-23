import { createRoot } from "react-dom/client";
import type { DesktopRuntimeMethod, RuntimeParams, RuntimeResult } from "@pico/protocol";
import { InspectorPanelController } from "../../apps/desktop/src/renderer/workbar-panels/InspectorPanelController.js";
import { DesktopSessionContinuity } from "../../apps/desktop/src/renderer/session-continuity.js";
import { invokeWorkbarRuntime } from "../../apps/desktop/src/renderer/workbar-panels/workbar-runtime.js";
const invoke = <M extends DesktopRuntimeMethod>(
  method: M,
  params: RuntimeParams<M>,
): Promise<RuntimeResult<M>> => invokeWorkbarRuntime(window.pico.runtime, method, params);
const host = window as typeof window & {
  invoke: typeof invoke;
  mount: (scope: { workspacePath: string; sessionId: string }) => Promise<void>;
  setActive: (active: boolean) => void;
};
host.invoke = invoke;
const continuity = new DesktopSessionContinuity({
  transport: {
    open: (params) => invoke("session.subscription.open", params),
    close: (params) => invoke("session.subscription.close", params),
    page: (params) => invoke("session.transcript.page", params),
    advance: (params) => invoke("session.transcript.advance", params),
    subscribeFrames: (listener, onDisconnect) =>
      window.pico.sessionFrames.subscribe(listener, onDisconnect),
  },
  onView() {},
  onError(error) {
    console.error(error);
  },
});
const root = createRoot(document.getElementById("root")!);
host.mount = async (scope) => {
  await continuity.open(scope.workspacePath, scope.sessionId);
  host.setActive = (active) =>
    root.render(
      <InspectorPanelController
        {...scope}
        kind="inspector"
        instanceId="test"
        readOnly={false}
        active={active}
      />,
    );
  host.setActive(true);
};
