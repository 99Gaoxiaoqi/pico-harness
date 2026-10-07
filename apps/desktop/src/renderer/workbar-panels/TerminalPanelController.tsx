import {
  TERMINAL_STREAM_RUNTIME_CAPABILITY,
  type RuntimeResult,
  type RuntimeTerminalFrame,
  type RuntimeTerminalSession,
} from "@pico/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesktopRuntimeApi } from "../../preload/contract.js";
import {
  TerminalWorkbarPanel,
  type WorkbarTerminalGrid,
  type WorkbarTerminalInstance,
  type WorkbarTerminalOutput,
} from "./TerminalWorkbarPanel.js";
import type { WorkbarPanelHostProps, WorkbarScope } from "./workbar-panel-contract.js";
import {
  invokeWorkbarRuntime,
  workbarErrorMessage,
  WorkbarPanelRuntimeError,
} from "./workbar-runtime.js";
import { stringField } from "./workbar-values.js";
import { createTerminalInputQueue } from "./terminal-input-queue.js";

const TERMINAL_ATTACH_BYTES = 64 * 1024;

const TERMINAL_OUTPUT_BYTES = 512 * 1024;

interface TerminalAttachmentState {
  readonly epoch: string;
  readonly sequence: number;
  readonly text: string;
  readonly truncated: boolean;
  readonly startOffset: number;
  readonly resetVersion: number;
}

export interface WorkbarTerminalInstanceScope extends WorkbarScope {
  readonly instanceId: string;
}

export interface WorkbarTerminalBinding {
  readonly terminalId: string;
  readonly resourceEpoch: string;
}

const terminalBindings = new Map<string, Map<string, string>>();

export function listWorkbarTerminalBindings(
  scope: WorkbarTerminalInstanceScope,
): readonly WorkbarTerminalBinding[] {
  return [...(terminalBindings.get(terminalBindingKey(scope)) ?? new Map())].map(
    ([terminalId, resourceEpoch]) => ({ terminalId, resourceEpoch }),
  );
}

/** Called by the Workbar close action before it removes a Terminal tab. */
export async function stopWorkbarTerminalInstance(
  runtime: DesktopRuntimeApi,
  scope: WorkbarTerminalInstanceScope,
): Promise<number> {
  const key = terminalBindingKey(scope);
  const bindings = [...(terminalBindings.get(key) ?? new Map())];
  let stopped = 0;
  for (const [terminalId, resourceEpoch] of bindings) {
    try {
      await invokeWorkbarRuntime(runtime, "terminal.stop", {
        workspacePath: scope.workspacePath,
        sessionId: scope.sessionId,
        terminalId,
        resourceEpoch,
      });
      stopped += 1;
      terminalBindings.get(key)?.delete(terminalId);
    } catch (cause) {
      if (!isEpochConflict(cause)) throw cause;
      const streamId = crypto.randomUUID();
      const attached = await invokeWorkbarRuntime(runtime, "terminal.attach", {
        workspacePath: scope.workspacePath,
        sessionId: scope.sessionId,
        terminalId,
        maxBytes: 1,
        streamId,
      });
      try {
        await invokeWorkbarRuntime(runtime, "terminal.stop", {
          workspacePath: scope.workspacePath,
          sessionId: scope.sessionId,
          terminalId,
          resourceEpoch: attached.resourceEpoch,
        });
      } finally {
        await invokeWorkbarRuntime(runtime, "terminal.detach", {
          workspacePath: scope.workspacePath,
          sessionId: scope.sessionId,
          terminalId,
          resourceEpoch: attached.resourceEpoch,
          streamId,
        }).catch(() => undefined);
      }
      stopped += 1;
      terminalBindings.get(key)?.delete(terminalId);
    }
  }
  if (terminalBindings.get(key)?.size === 0) terminalBindings.delete(key);
  return stopped;
}

export function TerminalPanelController({
  workspacePath,
  sessionId,
  instanceId,
  active,
  readOnly,
}: WorkbarPanelHostProps) {
  const runtime = window.pico.runtime;
  const [streamId] = useState(() => crypto.randomUUID());
  const scope = useMemo(() => ({ workspacePath, sessionId }), [workspacePath, sessionId]);
  const [terminals, setTerminals] = useState<readonly WorkbarTerminalInstance[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string>();
  const [output, setOutput] = useState<WorkbarTerminalOutput>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const initializedRef = useRef(false);
  const streamReadyRef = useRef(false);
  const ensureTerminalStream = useCallback(async () => {
    if (streamReadyRef.current) return;
    const ping = await invokeWorkbarRuntime(runtime, "runtime.ping", {});
    if (!ping.capabilities?.includes(TERMINAL_STREAM_RUNTIME_CAPABILITY)) {
      throw new Error(
        "当前 Runtime Host 不支持终端推送，请更新 Pico 并重启 Runtime Host 后重新打开终端。",
      );
    }
    streamReadyRef.current = true;
  }, [runtime]);
  const activeTerminalIdRef = useRef<string | undefined>(undefined);
  const attachmentsRef = useRef(new Map<string, TerminalAttachmentState>());
  const terminalsRef = useRef(terminals);
  terminalsRef.current = terminals;
  const accessRef = useRef({ active, readOnly });
  accessRef.current = { active, readOnly };
  const attachedJobsRef = useRef(new Map<string, Promise<TerminalAttachmentState>>());
  const syncingRef = useRef(new Set<string>());
  const pendingFramesRef = useRef<RuntimeTerminalFrame[]>([]);
  const pendingFrameBytesRef = useRef(0);
  const creatingRef = useRef(false);
  const overflowedRef = useRef(new Set<string>());
  const inputQueuesRef = useRef(new Map<string, ReturnType<typeof createTerminalInputQueue>>());
  const disposedRef = useRef(false);
  const connectionGenerationRef = useRef(0);
  const attachRef = useRef<(terminalId: string) => Promise<TerminalAttachmentState>>(() =>
    Promise.reject(),
  );

  const markDetached = useCallback((terminalId?: string) => {
    for (const [id, queue] of inputQueuesRef.current) {
      if (terminalId && id !== terminalId) continue;
      queue.dispose();
      inputQueuesRef.current.delete(id);
    }
    const detach = (items: readonly WorkbarTerminalInstance[]) =>
      items.map((terminal) =>
        !terminalId || terminal.id === terminalId ? { ...terminal, attached: false } : terminal,
      );
    terminalsRef.current = detach(terminalsRef.current);
    setTerminals(detach);
  }, []);

  const applyFrame = useCallback((frame: RuntimeTerminalFrame): boolean => {
    const current = attachmentsRef.current.get(frame.terminalId);
    if (!current || current.epoch !== frame.resourceEpoch) return false;
    if (frame.sequence <= current.sequence) return true;
    if (frame.sequence !== current.sequence + 1) return false;
    const text =
      frame.kind === "output"
        ? appendTerminalOutput(current.text, frame.data, TERMINAL_OUTPUT_BYTES)
        : current.text;
    const attachment = {
      ...current,
      sequence: frame.sequence,
      text,
      truncated:
        current.truncated ||
        text.length < current.text.length + (frame.kind === "output" ? frame.data.length : 0),
      startOffset:
        current.startOffset +
        current.text.length +
        (frame.kind === "output" ? frame.data.length : 0) -
        text.length,
    };
    attachmentsRef.current.set(frame.terminalId, attachment);
    const update = (items: readonly WorkbarTerminalInstance[]) =>
      items.map((terminal) =>
        terminal.id === frame.terminalId
          ? {
              ...terminal,
              sequence: frame.sequence,
              ...(frame.kind === "status"
                ? {
                    status:
                      frame.status === "interrupted"
                        ? ("interrupted" as const)
                        : ("exited" as const),
                    exitCode: frame.exitCode,
                  }
                : {}),
            }
          : terminal,
      );
    terminalsRef.current = update(terminalsRef.current);
    setTerminals(update);
    if (activeTerminalIdRef.current === frame.terminalId)
      setOutput(terminalOutputView(frame.terminalId, attachment));
    return true;
  }, []);

  const takePendingFrames = useCallback((terminalId: string) => {
    const taken = pendingFramesRef.current.filter((frame) => frame.terminalId === terminalId);
    pendingFramesRef.current = pendingFramesRef.current.filter(
      (frame) => frame.terminalId !== terminalId,
    );
    pendingFrameBytesRef.current -= taken.reduce(
      (total, frame) =>
        total + (frame.kind === "output" ? new TextEncoder().encode(frame.data).byteLength : 0),
      0,
    );
    return taken;
  }, []);

  const bufferFrame = useCallback(
    (frame: RuntimeTerminalFrame) => {
      const pending = pendingFramesRef.current;
      const bytes = frame.kind === "output" ? new TextEncoder().encode(frame.data).byteLength : 0;
      if (pending.length >= 1024 || pendingFrameBytesRef.current + bytes > TERMINAL_OUTPUT_BYTES) {
        overflowedRef.current.add(frame.terminalId);
        takePendingFrames(frame.terminalId);
        return;
      }
      pendingFrameBytesRef.current += bytes;
      pending.push(frame);
    },
    [takePendingFrames],
  );

  const applyAttachment = useCallback(
    (value: RuntimeResult<"terminal.attach"> | RuntimeResult<"terminal.create">) => {
      const current = attachmentsRef.current.get(value.terminal.terminalId);
      const attachment = {
        epoch: value.resourceEpoch,
        sequence: value.sequence,
        text: value.snapshot,
        truncated: value.truncated,
        startOffset: 0,
        resetVersion: (current?.resetVersion ?? 0) + 1,
      } satisfies TerminalAttachmentState;
      attachmentsRef.current.set(value.terminal.terminalId, attachment);
      const key = terminalBindingKey({ workspacePath, sessionId, instanceId });
      const bindings = terminalBindings.get(key);
      if (bindings?.has(value.terminal.terminalId)) {
        bindings.set(value.terminal.terminalId, value.resourceEpoch);
      }
      setTerminals((items) => upsertTerminal(items, terminalView(value.terminal, true)));
      setOutput((currentOutput) =>
        activeTerminalIdRef.current === value.terminal.terminalId || !currentOutput
          ? terminalOutputView(value.terminal.terminalId, attachment)
          : currentOutput,
      );
      return attachment;
    },
    [instanceId, sessionId, workspacePath],
  );

  const attach = useCallback(
    (terminalId: string): Promise<TerminalAttachmentState> => {
      const existing = attachedJobsRef.current.get(terminalId);
      if (existing) return existing;
      syncingRef.current.add(terminalId);
      markDetached(terminalId);
      overflowedRef.current.delete(terminalId);
      const generation = connectionGenerationRef.current;
      const job = (async () => {
        await ensureTerminalStream();
        if (disposedRef.current || generation !== connectionGenerationRef.current) {
          throw new Error("终端连接已变化，请重新连接。");
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          overflowedRef.current.delete(terminalId);
          const value = await invokeWorkbarRuntime(runtime, "terminal.attach", {
            ...scope,
            streamId,
            terminalId,
            maxBytes: TERMINAL_ATTACH_BYTES,
          });
          if (disposedRef.current || generation !== connectionGenerationRef.current) {
            await invokeWorkbarRuntime(runtime, "terminal.detach", {
              ...scope,
              streamId,
              terminalId,
              resourceEpoch: value.resourceEpoch,
            }).catch(() => undefined);
            throw new Error("终端连接已变化，请重新连接。");
          }
          const attachment = applyAttachment(value);
          const frames = takePendingFrames(terminalId);
          let complete = !overflowedRef.current.delete(terminalId);
          for (const frame of frames) {
            if (frame.resourceEpoch !== value.resourceEpoch || frame.sequence <= value.sequence)
              continue;
            if (!applyFrame(frame)) complete = false;
          }
          if (complete) {
            setError(undefined);
            return attachment;
          }
          markDetached(terminalId);
        }
        throw new Error("终端输出未连续，请重新连接以恢复快照。");
      })().finally(() => {
        syncingRef.current.delete(terminalId);
        attachedJobsRef.current.delete(terminalId);
      });
      attachedJobsRef.current.set(terminalId, job);
      return job;
    },
    [
      applyAttachment,
      applyFrame,
      ensureTerminalStream,
      markDetached,
      runtime,
      scope,
      streamId,
      takePendingFrames,
    ],
  );
  attachRef.current = attach;

  useEffect(() => {
    disposedRef.current = false;
    const subscription = window.pico.terminalFrames.subscribe(
      (frame) => {
        if (frame.sessionId !== sessionId || frame.streamId !== streamId || disposedRef.current)
          return;
        if (
          !attachmentsRef.current.has(frame.terminalId) &&
          !syncingRef.current.has(frame.terminalId) &&
          !creatingRef.current
        )
          return;
        if (
          syncingRef.current.has(frame.terminalId) ||
          !attachmentsRef.current.has(frame.terminalId)
        ) {
          bufferFrame(frame);
          return;
        }
        if (applyFrame(frame)) return;
        bufferFrame(frame);
        markDetached(frame.terminalId);
        void attachRef
          .current(frame.terminalId)
          .catch((cause: unknown) => setError(workbarErrorMessage(cause)));
      },
      () => {
        const generation = ++connectionGenerationRef.current;
        streamReadyRef.current = false;
        markDetached();
        pendingFramesRef.current = [];
        pendingFrameBytesRef.current = 0;
        const terminalId = activeTerminalIdRef.current;
        if (terminalId && accessRef.current.active) {
          // A read reconnects the shared Runtime request socket and restores its watermark.
          const pending = attachedJobsRef.current.get(terminalId) ?? Promise.resolve();
          void pending
            .catch(() => undefined)
            .then(() => {
              if (
                disposedRef.current ||
                generation !== connectionGenerationRef.current ||
                !accessRef.current.active
              )
                return;
              return attachRef.current(terminalId);
            })
            .catch((cause: unknown) => setError(workbarErrorMessage(cause)));
        }
      },
    );
    return () => {
      disposedRef.current = true;
      connectionGenerationRef.current += 1;
      subscription.dispose();
      for (const queue of inputQueuesRef.current.values()) queue.dispose();
      inputQueuesRef.current.clear();
    };
  }, [applyFrame, bufferFrame, markDetached, sessionId, streamId]);

  const create = useCallback(async () => {
    if (readOnly) {
      setError("当前任务只读，不能新建终端。");
      return;
    }
    setLoading(true);
    setError(undefined);
    creatingRef.current = true;
    try {
      await ensureTerminalStream();
      const value = await invokeWorkbarRuntime(runtime, "terminal.create", { ...scope, streamId });
      bindTerminalToInstance(
        { workspacePath, sessionId, instanceId },
        value.terminal.terminalId,
        value.resourceEpoch,
      );
      activeTerminalIdRef.current = value.terminal.terminalId;
      setActiveTerminalId(value.terminal.terminalId);
      applyAttachment(value);
      const frames = takePendingFrames(value.terminal.terminalId);
      let complete = !overflowedRef.current.delete(value.terminal.terminalId);
      for (const frame of frames) {
        if (frame.resourceEpoch !== value.resourceEpoch || frame.sequence <= value.sequence)
          continue;
        if (!applyFrame(frame)) complete = false;
      }
      if (!complete) await attach(value.terminal.terminalId);
    } catch (cause) {
      setError(workbarErrorMessage(cause));
    } finally {
      creatingRef.current = false;
      for (const frame of [...pendingFramesRef.current]) {
        if (!attachmentsRef.current.has(frame.terminalId)) takePendingFrames(frame.terminalId);
      }
      setLoading(false);
    }
  }, [
    applyAttachment,
    applyFrame,
    attach,
    ensureTerminalStream,
    instanceId,
    readOnly,
    runtime,
    scope,
    sessionId,
    streamId,
    takePendingFrames,
    workspacePath,
  ]);

  const initialize = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      await ensureTerminalStream();
      const listed = await invokeWorkbarRuntime(runtime, "terminal.list", scope);
      setTerminals(listed.terminals.map((terminal) => terminalView(terminal, false)));
      const bindingScope = { workspacePath, sessionId, instanceId };
      const knownIds = new Set(listed.terminals.map((terminal) => terminal.terminalId));
      const key = terminalBindingKey(bindingScope);
      const bindings = terminalBindings.get(key);
      for (const terminalId of bindings?.keys() ?? []) {
        if (!knownIds.has(terminalId)) bindings?.delete(terminalId);
      }
      if (bindings?.size === 0) terminalBindings.delete(key);
      const bound = listed.terminals.find((terminal) => bindings?.has(terminal.terminalId));
      const selected = bound ?? (readOnly ? listed.terminals[0] : undefined);
      if (selected) {
        activeTerminalIdRef.current = selected.terminalId;
        setActiveTerminalId(selected.terminalId);
        await attach(selected.terminalId);
      } else if (!readOnly) {
        await create();
      }
    } catch (cause) {
      setError(workbarErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [
    attach,
    create,
    ensureTerminalStream,
    instanceId,
    readOnly,
    runtime,
    scope,
    sessionId,
    workspacePath,
  ]);

  useEffect(() => {
    if (!active || initializedRef.current) return;
    initializedRef.current = true;
    void initialize();
  }, [active, initialize]);

  const wasActiveRef = useRef(active);
  useEffect(() => {
    const restoring = active && !wasActiveRef.current;
    wasActiveRef.current = active;
    if (restoring && activeTerminalIdRef.current) {
      void attach(activeTerminalIdRef.current).catch((cause: unknown) =>
        setError(workbarErrorMessage(cause)),
      );
    }
  }, [active, attach]);

  useEffect(
    () => () => {
      for (const [terminalId, attachment] of attachmentsRef.current) {
        void invokeWorkbarRuntime(runtime, "terminal.detach", {
          ...scope,
          streamId,
          terminalId,
          resourceEpoch: attachment.epoch,
        }).catch(() => undefined);
      }
      attachmentsRef.current.clear();
    },
    [runtime, scope, streamId],
  );

  const select = useCallback(
    (terminalId: string) => {
      activeTerminalIdRef.current = terminalId;
      setActiveTerminalId(terminalId);
      const attachment = attachmentsRef.current.get(terminalId);
      setOutput(attachment ? terminalOutputView(terminalId, attachment) : undefined);
      const connected = terminalsRef.current.find(
        (terminal) => terminal.id === terminalId,
      )?.attached;
      if ((!attachment || !connected) && active) {
        void attach(terminalId).catch((cause: unknown) => setError(workbarErrorMessage(cause)));
      }
    },
    [active, attach],
  );

  const withAttachment = useCallback(
    async (
      terminalId: string,
      operation: (attachment: TerminalAttachmentState) => Promise<void>,
    ) => {
      let attachment = attachmentsRef.current.get(terminalId);
      if (!attachment) attachment = await attach(terminalId);
      try {
        await operation(attachment);
      } catch (cause) {
        if (!isEpochConflict(cause)) throw cause;
        attachment = await attach(terminalId);
        await operation(attachment);
      }
    },
    [attach],
  );

  const input = useCallback(
    (terminalId: string, data: string) => {
      const epoch = attachmentsRef.current.get(terminalId)?.epoch;
      const canSend = () => {
        const terminal = terminalsRef.current.find((item) => item.id === terminalId);
        return (
          accessRef.current.active &&
          !accessRef.current.readOnly &&
          activeTerminalIdRef.current === terminalId &&
          terminal?.status === "running" &&
          terminal.attached &&
          !syncingRef.current.has(terminalId) &&
          attachmentsRef.current.get(terminalId)?.epoch === epoch
        );
      };
      if (!epoch || !canSend()) return;
      let queue = inputQueuesRef.current.get(terminalId);
      if (!queue) {
        queue = createTerminalInputQueue({
          canSend,
          send: async (chunk) => {
            await invokeWorkbarRuntime(runtime, "terminal.input", {
              ...scope,
              terminalId,
              resourceEpoch: epoch,
              data: chunk,
            });
          },
          onError: (cause) => {
            markDetached(terminalId);
            setError(`${workbarErrorMessage(cause)} 输入未重发；请确认终端内容后重新连接。`);
          },
        });
        inputQueuesRef.current.set(terminalId, queue);
      }
      queue.enqueue(data);
    },
    [markDetached, runtime, scope],
  );

  const resize = useCallback(
    async (terminalId: string, grid: WorkbarTerminalGrid) => {
      if (readOnly) return;
      try {
        await withAttachment(terminalId, async (attachment) => {
          await invokeWorkbarRuntime(runtime, "terminal.resize", {
            ...scope,
            terminalId,
            resourceEpoch: attachment.epoch,
            cols: grid.columns,
            rows: grid.rows,
          });
        });
      } catch (cause) {
        setError(workbarErrorMessage(cause));
      }
    },
    [readOnly, runtime, scope, withAttachment],
  );

  const stop = useCallback(
    async (terminalId: string) => {
      if (readOnly) {
        setError("当前任务只读，不能停止终端。");
        return;
      }
      setError(undefined);
      try {
        await withAttachment(terminalId, async (attachment) => {
          const value = await invokeWorkbarRuntime(runtime, "terminal.stop", {
            ...scope,
            terminalId,
            resourceEpoch: attachment.epoch,
          });
          setTerminals((items) => upsertTerminal(items, terminalView(value.terminal, true)));
          terminalBindings
            .get(terminalBindingKey({ workspacePath, sessionId, instanceId }))
            ?.delete(terminalId);
        });
      } catch (cause) {
        setError(workbarErrorMessage(cause));
      }
    },
    [instanceId, readOnly, runtime, scope, sessionId, withAttachment, workspacePath],
  );

  return (
    <TerminalWorkbarPanel
      terminals={terminals}
      activeTerminalId={activeTerminalId}
      output={output}
      active={active}
      loading={loading}
      readOnly={readOnly}
      error={error}
      onCreate={() => void create()}
      onSelect={select}
      onAttach={(terminalId) =>
        void attach(terminalId).catch((cause: unknown) => setError(workbarErrorMessage(cause)))
      }
      onInput={input}
      onFocusChange={(focused) => window.pico.terminalFrames.setFocused(focused)}
      onClipboard={(action) => window.pico.terminalFrames.clipboard(action)}
      onResize={(terminalId, grid) => void resize(terminalId, grid)}
      onStop={(terminalId) => void stop(terminalId)}
    />
  );
}

export function appendTerminalOutput(current: string, chunk: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(current + chunk);
  if (bytes.byteLength <= maxBytes) return current + chunk;
  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return new TextDecoder().decode(bytes.subarray(start));
}

function terminalView(
  terminal: RuntimeTerminalSession,
  attached: boolean,
): WorkbarTerminalInstance {
  return {
    id: terminal.terminalId,
    title: stringField(terminal, "title") ?? `Shell ${terminal.terminalId.slice(0, 6)}`,
    status: terminal.status,
    attached,
    sequence: terminal.sequence,
    capability: terminal.capability,
    resizeSupported: terminal.resizeSupported,
    cwd: stringField(terminal, "cwd"),
    exitCode: terminal.exitCode,
  };
}

function upsertTerminal(
  terminals: readonly WorkbarTerminalInstance[],
  next: WorkbarTerminalInstance,
): readonly WorkbarTerminalInstance[] {
  const index = terminals.findIndex((terminal) => terminal.id === next.id);
  if (index < 0) return [...terminals, next];
  return terminals.map((terminal, candidate) => (candidate === index ? next : terminal));
}

function terminalOutputView(
  terminalId: string,
  attachment: TerminalAttachmentState,
): WorkbarTerminalOutput {
  return {
    terminalId,
    text: attachment.text,
    sequence: attachment.sequence,
    truncated: attachment.truncated,
    startOffset: attachment.startOffset,
    resetVersion: attachment.resetVersion,
  };
}

function terminalBindingKey(scope: WorkbarTerminalInstanceScope): string {
  return JSON.stringify([scope.workspacePath, scope.sessionId, scope.instanceId]);
}

function bindTerminalToInstance(
  scope: WorkbarTerminalInstanceScope,
  terminalId: string,
  resourceEpoch: string,
): void {
  const key = terminalBindingKey(scope);
  const bindings = terminalBindings.get(key) ?? new Map<string, string>();
  bindings.set(terminalId, resourceEpoch);
  terminalBindings.set(key, bindings);
}

function isEpochConflict(cause: unknown): boolean {
  return (
    cause instanceof WorkbarPanelRuntimeError &&
    (cause.code === "CONFLICT" || cause.message.toLowerCase().includes("epoch"))
  );
}
