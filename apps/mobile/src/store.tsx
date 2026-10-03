import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { Alert, AppState, Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { RemoteRuntimeClient } from "@pico/remote-client";
import {
  getRemoteMethodSpec,
  RemoteProtocolError,
  type RemoteMethod,
  type RemoteParams,
  type RemoteResult,
  type RemoteCapabilities,
  type RemoteSecretEdits,
} from "@pico/protocol/remote";
import type { RuntimeSessionSubscriptionFrame, RuntimeNotification } from "@pico/protocol/mobile";
import {
  GenerationFence,
  canUse,
  parseMobilePairing,
  type SavedHost,
  type Workspace,
  type ConnectionPhase,
  type RuntimePort,
} from "./core";
import { RecoverablePairing, type PairingProgress } from "./pairing";
import { connectionIssue, type ConnectionIssue } from "./connection-errors";
import { clearHostLocalData } from "./local-data";

type Store = RuntimePort & {
  hosts: SavedHost[];
  host?: SavedHost;
  workspace?: Workspace;
  workspaces: Workspace[];
  phase: ConnectionPhase;
  connected: boolean;
  generation: number;
  syncRevision: number;
  capabilities?: RemoteCapabilities;
  error?: string;
  errorInfo?: ConnectionIssue;
  pairing?: PairingProgress;
  connect: (host: SavedHost) => Promise<void>;
  disconnect: () => void;
  chooseWorkspace: (workspace: Workspace) => void;
  pair: (raw: string, name: string) => Promise<void>;
  resumePairing: () => Promise<void>;
  cancelPairing: () => Promise<void>;
  clearLocalData: (
    host: SavedHost,
    discardUnconfirmed?: boolean,
  ) => Promise<{ legacyCacheRemaining: boolean }>;
  remove: (host: SavedHost, discardUnconfirmed?: boolean) => Promise<void>;
  reason: (method: RemoteMethod) => string | undefined;
  report: (error: unknown) => void;
  perform: (task: () => Promise<unknown>) => Promise<void>;
  onFrame: (listener: (frame: RuntimeSessionSubscriptionFrame) => void) => () => void;
  onNotification: (listener: (event: RuntimeNotification) => void) => () => void;
  client?: RemoteRuntimeClient;
  requestWithSecrets: <M extends RemoteMethod>(
    method: M,
    params: RemoteParams<M>,
    secretEdits: RemoteSecretEdits,
  ) => Promise<RemoteResult<M>>;
};
const Context = createContext<Store | undefined>(undefined);
const HOSTS = "pico.mobile.hosts.v1";
const tokenKey = (id: string) => `pico.remote.${id.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
export function PicoProvider({ children }: { children: React.ReactNode }) {
  const [hosts, setHosts] = useState<SavedHost[]>([]);
  const [host, setHost] = useState<SavedHost>();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspace, setWorkspace] = useState<Workspace>();
  const [phase, setPhase] = useState<ConnectionPhase>("offline");
  const [generation, setGeneration] = useState(0);
  const [syncRevision, setSyncRevision] = useState(0);
  const [capabilities, setCapabilities] = useState<RemoteCapabilities>();
  const [error, setError] = useState<string>();
  const [errorInfo, setErrorInfo] = useState<ConnectionIssue>();
  const [pairing, setPairing] = useState<PairingProgress>();
  const pairingRef = useRef<RecoverablePairing | undefined>(undefined);
  const hostsRef = useRef<SavedHost[]>([]);
  const hostWrites = useRef<Promise<unknown>>(Promise.resolve());
  const cleaning = useRef(new Set<string>());
  const fence = useRef(new GenerationFence());
  const clientRef = useRef<RemoteRuntimeClient | undefined>(undefined);
  const hostRef = useRef<SavedHost | undefined>(undefined);
  const workspaceRef = useRef<Workspace | undefined>(undefined);
  const phaseRef = useRef<ConnectionPhase>("offline");
  const frameListeners = useRef(new Set<(frame: RuntimeSessionSubscriptionFrame) => void>());
  const notificationListeners = useRef(new Set<(event: RuntimeNotification) => void>());
  const eventsRef = useRef<{ dispose: () => void } | undefined>(undefined);
  const foreground = useRef(AppState.currentState === "active");
  const eventGeneration = useRef(0);
  const syncEpoch = useRef(0);
  const replayBuffer = useRef<
    { id: number; epoch: number; events: Map<string, RuntimeNotification> } | undefined
  >(undefined);
  const syncPromise = useRef<{ id: number; epoch: number; promise: Promise<void> } | undefined>(
    undefined,
  );
  function invalidateSync() {
    syncEpoch.current++;
    eventGeneration.current++;
    syncPromise.current = undefined;
    eventsRef.current?.dispose();
    eventsRef.current = undefined;
    replayBuffer.current = undefined;
  }
  function isCurrent(client: RemoteRuntimeClient, id: number, epoch = syncEpoch.current) {
    return (
      clientRef.current === client &&
      id === fence.current.current &&
      epoch === syncEpoch.current &&
      foreground.current
    );
  }
  function updatePhase(value: ConnectionPhase) {
    phaseRef.current = value;
    setPhase(value);
  }
  function report(e: unknown) {
    const issue = connectionIssue(e);
    setError(issue.message);
    setErrorInfo(issue);
  }
  function clearError() {
    setError(undefined);
    setErrorInfo(undefined);
  }
  async function perform(task: () => Promise<unknown>) {
    const id = fence.current.current;
    try {
      await task();
      if (id === fence.current.current) clearError();
    } catch (e) {
      if (id === fence.current.current) report(e);
    }
  }
  function resetConnection(keepSelection: boolean) {
    const id = fence.current.next();
    invalidateSync();
    eventsRef.current?.dispose();
    eventsRef.current = undefined;
    const previous = clientRef.current;
    clientRef.current = undefined;
    previous?.close();
    if (!keepSelection) {
      workspaceRef.current = undefined;
      hostRef.current = undefined;
      setHost(undefined);
      setWorkspace(undefined);
      setWorkspaces([]);
      setCapabilities(undefined);
    }
    updatePhase("offline");
    setGeneration(id);
    return id;
  }
  function disconnect() {
    resetConnection(false);
  }
  function sync(client: RemoteRuntimeClient, id: number): Promise<void> {
    const epoch = syncEpoch.current;
    if (!isCurrent(client, id, epoch)) return Promise.resolve();
    if (syncPromise.current?.id === id && syncPromise.current.epoch === epoch)
      return syncPromise.current.promise;
    const promise = (async () => {
      updatePhase("syncing");
      replayBuffer.current = { id, epoch, events: new Map() };
      const [caps, list] = await Promise.all([client.capabilities(), client.workspaces()]);
      if (!isCurrent(client, id, epoch)) return;
      setCapabilities(caps);
      setWorkspaces(list);
      const chosen = list.find((x) => x.id === workspaceRef.current?.id) ?? list[0];
      workspaceRef.current = chosen;
      setWorkspace(chosen);
      if (chosen) await subscribe(client, chosen, id);
      else {
        eventsRef.current?.dispose();
        eventsRef.current = undefined;
      }
      if (!isCurrent(client, id, epoch)) return;
      updatePhase("connected");
      clearError();
      setGeneration(id);
      setSyncRevision((revision) => revision + 1);
    })().catch((error) => {
      if (isCurrent(client, id, epoch)) {
        replayBuffer.current = undefined;
        report(error);
        updatePhase("blocked");
      }
    });
    syncPromise.current = { id, epoch, promise };
    void promise
      .finally(() => {
        if (syncPromise.current?.promise === promise) syncPromise.current = undefined;
      })
      .catch(() => undefined);
    return promise;
  }
  async function subscribe(client: RemoteRuntimeClient, w: Workspace, id: number) {
    const epoch = syncEpoch.current;
    const subscriptionGeneration = ++eventGeneration.current;
    eventsRef.current?.dispose();
    eventsRef.current = undefined;
    function receive(event: RuntimeNotification) {
      if (
        id === fence.current.current &&
        subscriptionGeneration === eventGeneration.current &&
        foreground.current
      ) {
        const buffer = replayBuffer.current;
        if (buffer?.id === id && buffer.epoch === epoch) {
          // These notifications trigger fresh reads; coalesce history by affected resource.
          const key = `${event.topic}/${event.scope.sessionId ?? ""}/${event.scope.jobId ?? ""}`;
          const previous = buffer.events.get(key);
          if (!previous || event.at >= previous.at) buffer.events.set(key, event);
        } else if (phaseRef.current === "connected") {
          for (const listener of notificationListeners.current) listener(event);
        }
      }
    }
    const subscription = await client.subscribe({ workspaceId: w.id }, receive);
    if (!isCurrent(client, id, epoch) || subscriptionGeneration !== eventGeneration.current) {
      subscription.dispose();
      return;
    }
    eventsRef.current = subscription;
    for (const event of subscription.replay.events) receive(event);
  }
  // Flush only after connected consumers have committed their new read scope.
  useEffect(() => {
    const buffer = replayBuffer.current;
    if (phase !== "connected" || !buffer) return;
    const timer = setTimeout(() => {
      if (
        replayBuffer.current !== buffer ||
        phaseRef.current !== "connected" ||
        buffer.id !== fence.current.current ||
        buffer.epoch !== syncEpoch.current ||
        !foreground.current
      )
        return;
      replayBuffer.current = undefined;
      for (const event of buffer.events.values())
        for (const listener of notificationListeners.current) listener(event);
    }, 0);
    return () => clearTimeout(timer);
  }, [phase, generation, syncRevision]);
  async function connect(selected: SavedHost) {
    if (cleaning.current.has(selected.id))
      throw new Error("正在清理这台电脑的本机数据，请稍后连接");
    const id = resetConnection(hostRef.current?.id === selected.id);
    setHost(selected);
    hostRef.current = selected;
    clearError();
    updatePhase("connecting");
    try {
      const token = await SecureStore.getItemAsync(tokenKey(selected.id));
      fence.current.assert(id);
      if (!token)
        throw Object.assign(new Error("设备凭据已丢失，请重新配对"), {
          code: "MISSING_CREDENTIAL",
        });
      const client: RemoteRuntimeClient = new RemoteRuntimeClient({
        publicUrl: selected.baseUrl,
        deviceToken: token,
        gatewayId: selected.gatewayId,
        onState: (state, stateError) => {
          if (clientRef.current !== client) return;
          if (
            state === "connected" &&
            foreground.current &&
            phaseRef.current !== "syncing" &&
            phaseRef.current !== "connected"
          )
            void sync(client, fence.current.current);
          else if (state === "unauthorized" || state === "incompatible" || state === "error") {
            invalidateSync();
            updatePhase("blocked");
            if (state === "unauthorized") {
              workspaceRef.current = undefined;
              setWorkspace(undefined);
              setWorkspaces([]);
              setCapabilities(undefined);
            }
            if (stateError) report(stateError);
          } else if (state === "connecting" || state === "reconnecting") {
            invalidateSync();
            updatePhase(foreground.current ? "connecting" : "background");
          } else if (state === "disconnected") {
            invalidateSync();
            updatePhase(foreground.current ? "connecting" : "background");
          }
        },
      });
      clientRef.current = client;
      client.subscribeSessionFrames(
        (frame) => {
          if (clientRef.current === client && foreground.current)
            for (const listener of frameListeners.current) listener(frame);
        },
        () => {
          if (clientRef.current === client) {
            invalidateSync();
            updatePhase(foreground.current ? "connecting" : "background");
          }
        },
      );
      if (!foreground.current) {
        client.setForeground(false);
        updatePhase("background");
        return;
      }
      await client.connect();
      fence.current.assert(id);
      if (isCurrent(client, id) && phaseRef.current !== "connected") await sync(client, id);
    } catch (e) {
      if (id === fence.current.current) {
        report(e);
        if (!clientRef.current) updatePhase("blocked");
      }
    }
  }
  function chooseWorkspace(w: Workspace) {
    if (phaseRef.current !== "connected") return;
    invalidateSync();
    workspaceRef.current = w;
    setWorkspace(w);
    setGeneration(fence.current.next());
    const id = fence.current.current;
    // Client connection belongs to host generation; switching workspace uses its own event fence.
    const client = clientRef.current;
    if (client) void sync(client, id);
  }
  async function request<M extends RemoteMethod>(
    method: M,
    params: RemoteParams<M>,
    explicitWorkspaceId?: string,
  ): Promise<RemoteResult<M>> {
    const client = clientRef.current;
    const id = fence.current.current;
    if (!client || !foreground.current || phaseRef.current !== "connected")
      throw new RemoteProtocolError(
        "CLIENT_NOT_READY",
        "电脑尚未连接或正在同步",
        false,
        "not_executed",
      );
    const workspaceId =
      explicitWorkspaceId ??
      (getRemoteMethodSpec(method).workspaceRequired ? workspaceRef.current?.id : undefined);
    const result = await client.request(method, params, {
      ...(workspaceId ? { workspaceId } : {}),
    });
    fence.current.assert(id);
    return result;
  }
  function mutateHosts(update: (current: SavedHost[]) => SavedHost[]) {
    const operation = hostWrites.current
      .catch(() => undefined)
      .then(async () => {
        const updated = update(hostsRef.current);
        await AsyncStorage.setItem(HOSTS, JSON.stringify(updated));
        hostsRef.current = updated;
        setHosts(updated);
      });
    hostWrites.current = operation;
    return operation;
  }
  async function forget(saved: SavedHost) {
    if (hostRef.current?.id === saved.id) disconnect();
    await SecureStore.deleteItemAsync(tokenKey(saved.id));
    await mutateHosts((current) => current.filter((x) => x.id !== saved.id));
  }
  async function withCredential(saved: SavedHost, token: string, action: "verify" | "revoke") {
    const client = new RemoteRuntimeClient({
      publicUrl: saved.baseUrl,
      deviceToken: token,
      gatewayId: saved.gatewayId,
    });
    try {
      if (action === "verify") await client.capabilities();
      else await client.revoke();
    } finally {
      client.close();
    }
  }
  if (!pairingRef.current) {
    pairingRef.current = new RecoverablePairing(
      {
        getItemAsync: SecureStore.getItemAsync,
        setItemAsync: (key, value) =>
          SecureStore.setItemAsync(key, value, {
            keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
          }),
        deleteItemAsync: SecureStore.deleteItemAsync,
      },
      {
        submit: (offer, deviceName) =>
          RemoteRuntimeClient.submitPairing(offer, {
            deviceName,
            platform: Platform.OS === "ios" ? "ios" : "android",
          }),
        status: RemoteRuntimeClient.pairingStatus,
        acknowledge: RemoteRuntimeClient.acknowledgePairing,
        verify: (saved, token) => withCredential(saved, token, "verify"),
        revoke: (saved, token) => withCredential(saved, token, "revoke"),
        install: async (saved, token) => {
          await SecureStore.setItemAsync(tokenKey(saved.id), token, {
            keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
          });
          await mutateHosts((current) => [...current.filter((x) => x.id !== saved.id), saved]);
        },
        forget,
        changed: setPairing,
      },
    );
    pairingRef.current.setForeground(foreground.current);
  }
  async function pair(raw: string, name: string) {
    clearError();
    const saved = await pairingRef.current!.start(
      parseMobilePairing(raw),
      name.trim() || "我的手机",
    );
    if (saved && foreground.current && hostRef.current?.id !== saved.id) await connect(saved);
  }
  async function resumePairing() {
    const saved = await pairingRef.current!.resume();
    if (
      saved &&
      foreground.current &&
      !cleaning.current.has(saved.id) &&
      hostRef.current?.id !== saved.id
    )
      await connect(saved);
  }
  async function cancelPairing() {
    const result = await pairingRef.current!.cancel();
    clearError();
    if (result.remoteRevocationUnconfirmed)
      Alert.alert(
        "本机配对申请已清除",
        "电脑撤销结果未确认，请在电脑检查设备授权并执行 pico remote devices revoke。未确认授予会按原期限失效。",
      );
  }
  async function withCleanup<T>(saved: SavedHost, action: () => Promise<T>): Promise<T> {
    if (cleaning.current.has(saved.id)) throw new Error("这台电脑的本机数据正在清理");
    cleaning.current.add(saved.id);
    try {
      if (hostRef.current?.id === saved.id) disconnect();
      if ((await pairingRef.current!.inspectGatewayId()) === saved.gatewayId) await cancelPairing();
      const result = await action();
      clearError();
      return result;
    } catch (error) {
      report(error);
      throw error;
    } finally {
      cleaning.current.delete(saved.id);
    }
  }
  async function clearLocalData(saved: SavedHost, discardUnconfirmed = false) {
    return withCleanup(saved, () => clearHostLocalData(saved.id, { discardUnconfirmed }));
  }
  async function remove(saved: SavedHost, discardUnconfirmed = false) {
    return withCleanup(saved, async () => {
      const result = await clearHostLocalData(saved.id, { discardUnconfirmed });
      const token = await SecureStore.getItemAsync(tokenKey(saved.id));
      let revoked = false;
      if (token) {
        try {
          await withCredential(saved, token, "revoke");
          revoked = true;
        } catch {
          /* Local unlink still works offline; do not claim remote revocation. */
        }
      }
      await forget(saved);
      Alert.alert(
        "本机配对与数据已移除",
        [
          revoked
            ? "电脑已撤销此设备授权。"
            : "电脑撤销结果未确认，请在电脑检查设备并执行 pico remote devices revoke。",
          result.legacyCacheRemaining
            ? "无法辨认电脑归属的旧版成果缓存仍保留，可在设置中单独清空。"
            : "",
          "电脑会话、任务和终端仍保留。",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    });
  }
  useEffect(() => {
    hostWrites.current = AsyncStorage.getItem(HOSTS)
      .then((raw) => {
        if (!raw) return;
        const saved = JSON.parse(raw) as SavedHost[];
        if (!Array.isArray(saved)) throw new Error("本机电脑列表无效");
        hostsRef.current = saved;
        setHosts(saved);
      })
      .catch(report);
    void hostWrites.current.then(() => resumePairing()).catch(report);
    const listener = AppState.addEventListener("change", (state) => {
      const active = state === "active";
      if (foreground.current === active) return;
      foreground.current = active;
      pairingRef.current!.setForeground(active);
      invalidateSync();
      if (active) void resumePairing().catch(report);
      const client = clientRef.current;
      if (!client) return;
      if (!foreground.current) {
        client.setForeground(false);
        updatePhase("background");
        return;
      }
      updatePhase("connecting");
      client.setForeground(true);
      void client
        .connect()
        .then(() =>
          !isCurrent(client, fence.current.current) || phaseRef.current === "connected"
            ? undefined
            : sync(client, fence.current.current),
        )
        .catch((error) => {
          if (isCurrent(client, fence.current.current)) report(error);
        });
    });
    return () => {
      listener.remove();
      pairingRef.current!.setForeground(false);
      disconnect();
    };
  }, []);
  const value: Store = {
    hosts,
    host,
    workspace,
    workspaces,
    phase,
    connected: phase === "connected",
    generation,
    syncRevision,
    capabilities,
    error,
    errorInfo,
    pairing,
    connect,
    disconnect,
    chooseWorkspace,
    pair,
    resumePairing,
    cancelPairing,
    clearLocalData,
    remove,
    request,
    requestWithSecrets: async (method, params, secretEdits) => {
      const id = fence.current.current;
      const client = clientRef.current;
      if (!client || !foreground.current || phaseRef.current !== "connected")
        throw new RemoteProtocolError(
          "CLIENT_NOT_READY",
          "电脑尚未连接或正在同步",
          false,
          "not_executed",
        );
      const result = await client.request(method, params, {
        workspaceId: getRemoteMethodSpec(method).workspaceRequired
          ? workspaceRef.current?.id
          : undefined,
        secretEdits,
      });
      fence.current.assert(id);
      return result;
    },
    report,
    perform,
    reason: (method) =>
      phase !== "connected" ? "等待连接恢复与同步" : canUse(capabilities, method),
    onFrame: (listener) => {
      frameListeners.current.add(listener);
      return () => {
        frameListeners.current.delete(listener);
      };
    },
    onNotification: (listener) => {
      notificationListeners.current.add(listener);
      return () => {
        notificationListeners.current.delete(listener);
      };
    },
    client: clientRef.current,
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function usePico() {
  const context = useContext(Context);
  if (!context) throw new Error("PicoProvider missing");
  return context;
}
