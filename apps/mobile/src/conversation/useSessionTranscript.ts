import { useEffect, useRef, useState } from "react";
import type { RuntimePlanControlSnapshot, RuntimeSessionSettings } from "@pico/protocol/mobile";
import type { TranscriptReplicaView } from "@pico/transcript-replica";
import { MobileTranscript } from "../transcript";
import { usePico } from "../store";

export function useSessionTranscript(sessionId: string) {
  const pico = usePico();
  const [view, setView] = useState<TranscriptReplicaView>();
  const [sessionReady, setSessionReady] = useState(false);
  const [settings, setSettings] = useState<RuntimeSessionSettings>();
  const [plan, setPlan] = useState<RuntimePlanControlSnapshot>();
  const controller = useRef<MobileTranscript | undefined>(undefined);
  useEffect(() => {
    setSessionReady(false);
    if (!pico.workspace || !pico.connected) return;
    let subscribed = true;
    const subscription = new MobileTranscript(pico, pico.workspace.id, sessionId, (v) => {
      setView(v);
      setPlan(subscription.planControl);
    });
    controller.current = subscription;
    const off = pico.onFrame((frame) => void subscription.receive(frame).catch(pico.report));
    const offNotifications = pico.onNotification((event) => {
      if (event.scope.sessionId !== sessionId) return;
      if (event.topic === "plan.updated") void subscription.open().catch(pico.report);
      if (event.topic === "session.settingsUpdated")
        void pico
          .request("session.settings.get", { sessionId })
          .then((x) => setSettings(x.settings))
          .catch(pico.report);
    });
    void subscription
      .open()
      .then(() => {
        if (subscribed) setSessionReady(true);
      })
      .catch(pico.report);
    void pico
      .request("session.settings.get", { sessionId })
      .then((x) => setSettings(x.settings))
      .catch(pico.report);
    return () => {
      subscribed = false;
      off();
      offNotifications();
      subscription.dispose();
      controller.current = undefined;
    };
  }, [pico.generation, pico.connected, pico.workspace?.id, sessionId]);
  useEffect(() => {
    setView(undefined);
  }, [sessionId, pico.host?.id, pico.workspace?.id]);

  function loadOlder() {
    return controller.current!.older();
  }
  function refreshTranscript() {
    return controller.current?.open();
  }

  return { view, sessionReady, settings, plan, loadOlder, refreshTranscript };
}
