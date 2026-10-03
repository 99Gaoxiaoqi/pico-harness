import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { Alert, AppState, Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { RemoteRuntimeClient } from "@pico/remote-client";
import {
  getRemoteMethodSpec,
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
  errorText,
  parseMobilePairing,
  type SavedHost,
  type Workspace,
  type ConnectionPhase,
  type RuntimePort,
} from "./core";

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
  connect: (host: SavedHost) => Promise<void>;
  disconnect: () => void;
  chooseWorkspace: (workspace: Workspace) => void;
  pair: (raw: string, name: string) => Promise<void>;
  remove: (host: SavedHost) => Promise<void>;
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
  const syncPromise = useRef<{ id: number; epoch: number; promise: Promise<void> } | undefined>(
    undefined,
  );
  function invalidateSync() {
    syncEpoch.current++;
    eventGeneration.current++;
    syncPromise.current = undefined;
    eventsRef.current?.dispose();
    eventsRef.current = undefined;
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
    setError(errorText(e));
  }
  async function perform(task: () => Promise<unknown>) {
    const id = fence.current.current;
    try {
      await task();
      if (id === fence.current.current) setError(undefined);
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
      setError(undefined);
      setGeneration(id);
    })().catch((error) => {
      if (isCurrent(client, id, epoch)) {
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
    const subscriptionGeneration = ++eventGeneration.current;
    eventsRef.current?.dispose();
    eventsRef.current = undefined;
    const subscription = await client.subscribe({ workspaceId: w.id }, (event) => {
      if (
        id === fence.current.current &&
        subscriptionGeneration === eventGeneration.current &&
        foreground.current
      )
        for (const listener of notificationListeners.current) listener(event);
    });
    if (!isCurrent(client, id) || subscriptionGeneration !== eventGeneration.current) {
      subscription.dispose();
      return;
    }
    eventsRef.current = subscription;
  }
  async function connect(selected: SavedHost) {
    const id = resetConnection(hostRef.current?.id === selected.id);
    setHost(selected);
    hostRef.current = selected;
    setError(undefined);
    updatePhase("connecting");
    try {
      const token = await SecureStore.getItemAsync(tokenKey(selected.id));
      fence.current.assert(id);
      if (!token) throw new Error("设备凭据已丢失，请重新配对");
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
    if (client)
      void subscribe(client, w, id).catch((error) => {
        if (isCurrent(client, id)) report(error);
      });
  }
  async function request<M extends RemoteMethod>(
    method: M,
    params: RemoteParams<M>,
    explicitWorkspaceId?: string,
  ): Promise<RemoteResult<M>> {
    const client = clientRef.current;
    const id = fence.current.current;
    if (!client || !foreground.current || phaseRef.current !== "connected")
      throw new Error("电脑尚未连接或正在同步");
    const workspaceId =
      explicitWorkspaceId ??
      (getRemoteMethodSpec(method).workspaceRequired ? workspaceRef.current?.id : undefined);
    const result = await client.request(method, params, {
      ...(workspaceId ? { workspaceId } : {}),
    });
    fence.current.assert(id);
    return result;
  }
  async function pair(raw: string, name: string) {
    const offer = parseMobilePairing(raw);
    const submitted = await RemoteRuntimeClient.submitPairing(offer, {
      deviceName: name.trim() || "我的手机",
      platform: Platform.OS === "ios" ? "ios" : "android",
    });
    setError("等待电脑本机批准，请查看 pico remote pair");
    while (Date.now() < submitted.expiresAt) {
      const status = await RemoteRuntimeClient.pairingStatus(offer.publicUrl, submitted);
      if (status.status === "approved") {
        if (
          status.gatewayId !== offer.gatewayId ||
          new URL(status.publicUrl).origin !== new URL(offer.publicUrl).origin
        )
          throw new Error("配对结果的电脑身份或地址不匹配");
        const saved: SavedHost = {
          id: `${status.gatewayId}.${status.deviceId}`,
          name: offer.publicUrl,
          baseUrl: status.publicUrl,
          deviceId: status.deviceId,
          gatewayId: status.gatewayId,
        };
        await SecureStore.setItemAsync(tokenKey(saved.id), status.deviceToken, {
          keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        });
        const updated = [...hosts.filter((x) => x.id !== saved.id), saved];
        await AsyncStorage.setItem(HOSTS, JSON.stringify(updated));
        setHosts(updated);
        await RemoteRuntimeClient.acknowledgePairing(offer.publicUrl, submitted);
        await connect(saved);
        return;
      }
      if (status.status !== "pending")
        throw new Error(status.status === "rejected" ? "电脑拒绝了配对" : "配对已过期");
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new Error("配对已过期，请在电脑重新生成二维码");
  }
  async function remove(saved: SavedHost) {
    const token = await SecureStore.getItemAsync(tokenKey(saved.id));
    if (token) {
      const c = new RemoteRuntimeClient({
        publicUrl: saved.baseUrl,
        deviceToken: token,
        gatewayId: saved.gatewayId,
      });
      try {
        await c.revoke();
      } catch {
        Alert.alert(
          "本地凭据已移除",
          "电脑可能尚未撤销授权，请在电脑执行 pico remote devices revoke。",
        );
      } finally {
        c.close();
      }
    }
    await SecureStore.deleteItemAsync(tokenKey(saved.id));
    const updated = hosts.filter((x) => x.id !== saved.id);
    await AsyncStorage.setItem(HOSTS, JSON.stringify(updated));
    setHosts(updated);
    if (hostRef.current?.id === saved.id) disconnect();
  }
  useEffect(() => {
    void AsyncStorage.getItem(HOSTS)
      .then((raw) => {
        if (raw) setHosts(JSON.parse(raw) as SavedHost[]);
      })
      .catch(report);
    const listener = AppState.addEventListener("change", (state) => {
      const active = state === "active";
      if (foreground.current === active) return;
      foreground.current = active;
      invalidateSync();
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
    connect,
    disconnect,
    chooseWorkspace,
    pair,
    remove,
    request,
    requestWithSecrets: async (method, params, secretEdits) => {
      const id = fence.current.current;
      const client = clientRef.current;
      if (!client || !foreground.current || phaseRef.current !== "connected")
        throw new Error("尚未连接");
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
