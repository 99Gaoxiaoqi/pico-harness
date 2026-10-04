import { useEffect, useRef, useState } from "react";
import type { RuntimePlanControlSnapshot, RuntimeSessionSettings } from "@pico/protocol/mobile";
import type { TranscriptReplicaView } from "@pico/transcript-replica";
import { MobileTranscript } from "../transcript";
import { usePico } from "../store";

export function useSessionTranscript(sessionId: string) {
  const pico = usePico();
  const [view, setView] = useState<TranscriptReplicaView>();
  const [sessionReady, setSessionReady] = useState(false);
  const [restoreVersion, setRestoreVersion] = useState(0);
  const [settings, setSettings] = useState<RuntimeSessionSettings>();
  const [plan, setPlan] = useState<RuntimePlanControlSnapshot>();
  const controller = useRef<MobileTranscript | undefined>(undefined);
  const controllerGeneration = useRef<number | undefined>(undefined);
  const latest = useRef(pico);
  latest.current = pico;
  const scope = `${pico.host?.id}/${pico.workspace?.id}/${sessionId}`;
  const controllerScope = useRef("");
  useEffect(() => {
    setView(undefined);
    setPlan(undefined);
    setSettings(undefined);
    setSessionReady(false);
    setRestoreVersion(0);
    controllerScope.current = scope;
    if (!pico.host || !pico.workspace) return;
    const subscription = new MobileTranscript(pico, pico.workspace.id, sessionId, (v) => {
      if (controller.current !== subscription) return;
      setView(v);
      setPlan(subscription.planControl);
      setSessionReady(latest.current.connected && subscription.ready);
      setRestoreVersion(subscription.restoreVersion);
    });
    controller.current = subscription;
    return () => {
      controller.current = undefined;
      subscription.dispose();
    };
  }, [pico.host?.id, pico.workspace?.id, sessionId]);
  useEffect(() => {
    const subscription = controller.current;
    if (!subscription) return;
    if (!pico.connected) {
      controllerGeneration.current = undefined;
      subscription.suspend();
      return;
    }
    controllerGeneration.current = pico.generation;
    const generation = pico.generation;
    const syncRevision = pico.syncRevision;
    let subscribed = true;
    const current = () =>
      subscribed &&
      controller.current === subscription &&
      latest.current.connected &&
      latest.current.generation === generation &&
      latest.current.syncRevision === syncRevision;
    const report = (error: unknown) => {
      if (current()) pico.report(error);
    };
    let settingsRead = 0;
    const settingsChanged = () => {
      const read = ++settingsRead;
      void pico
        .request("session.settings.get", { sessionId })
        .then((x) => {
          if (current() && read === settingsRead) setSettings(x.settings);
        })
        .catch(report);
    };
    const off = pico.onFrame((frame) => {
      if (current()) void subscription.receive(frame).catch(report);
    });
    const offNotifications = pico.onNotification((event) => {
      if (!current() || event.scope.sessionId !== sessionId) return;
      if (event.topic === "plan.updated") void subscription.open(pico).catch(report);
      if (event.topic === "session.settingsUpdated") settingsChanged();
    });
    void subscription.open(pico).catch(report);
    settingsChanged();
    return () => {
      subscribed = false;
      off();
      offNotifications();
      subscription.suspend();
    };
  }, [
    pico.generation,
    pico.connected,
    pico.syncRevision,
    pico.host?.id,
    pico.workspace?.id,
    sessionId,
  ]);

  function loadOlder() {
    return controller.current?.older() ?? Promise.resolve();
  }
  function refreshTranscript() {
    return controller.current?.open(latest.current);
  }

  const sameScope = controllerScope.current === scope;
  return {
    view: sameScope ? view : undefined,
    sessionReady:
      sameScope &&
      pico.connected &&
      controllerGeneration.current === pico.generation &&
      sessionReady,
    settings: sameScope ? settings : undefined,
    plan: sameScope ? plan : undefined,
    restoreVersion: sameScope ? restoreVersion : 0,
    loadOlder,
    refreshTranscript,
  };
}
