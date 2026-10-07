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

interface TerminalInstanceLifecycle {
  binding?: WorkbarTerminalBinding;
  creation?: {
    readonly streamId: string;
    readonly promise: Promise<RuntimeResult<"terminal.create"> | undefined>;
  };
  closing?: Promise<number>;
  closed: boolean;
}

const terminalInstances = new Map<string, TerminalInstanceLifecycle>();

export function listWorkbarTerminalBindings(
  scope: WorkbarTerminalInstanceScope,
): readonly WorkbarTerminalBinding[] {
  const binding = terminalInstances.get(terminalBindingKey(scope))?.binding;
  return binding ? [binding] : [];
}

/** Called by the Workbar close action before it removes a Terminal tab. */
export async function stopWorkbarTerminalInstance(
  runtime: DesktopRuntimeApi,
  scope: WorkbarTerminalInstanceScope,
): Promise<number> {
  const key = terminalBindingKey(scope);
  const instance = terminalInstanceLifecycle(key);
  if (instance.closing) return instance.closing;
  // A late list must not create a shell after the tab has been closed.
  instance.closed = true;
  const closing = (async () => {
    await instance.creation?.promise.catch(() => undefined);
    const binding = instance.binding;
    if (!binding) return 0;
    const { terminalId, resourceEpoch } = binding;
    try {
      await invokeWorkbarRuntime(runtime, "terminal.stop", {
        workspacePath: scope.workspacePath,
        sessionId: scope.sessionId,
        terminalId,
        resourceEpoch,
      });
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
    }
    instance.binding = undefined;
    return 1;
  })()
    .catch((cause: unknown) => {
      // Keep the binding and allow reconnect/close to be retried by the retained tab.
      instance.closed = false;
      throw cause;
    })
    .finally(() => {
      instance.closing = undefined;
    });
  instance.closing = closing;
  return closing;
}

export function TerminalPanelController({
  workspacePath,
  sessionId,
  instanceId,
  terminalTitle,
  active,
  readOnly,
}: WorkbarPanelHostProps) {
  const runtime = window.pico.runtime;
  const [streamId] = useState(() => crypto.randomUUID());
  const scope = useMemo(() => ({ workspacePath, sessionId }), [workspacePath, sessionId]);
  const instance = useMemo(
    () => terminalInstanceLifecycle(terminalBindingKey({ workspacePath, sessionId, instanceId })),
    [instanceId, sessionId, workspacePath],
  );
  const [terminal, setTerminal] = useState<WorkbarTerminalInstance>();
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
  const attachmentsRef = useRef(new Map<string, TerminalAttachmentState>());
  const terminalRef = useRef(terminal);
  terminalRef.current = terminal;
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
    const current = terminalRef.current;
    if (current && (!terminalId || current.id === terminalId)) {
      terminalRef.current = { ...current, attached: false };
      setTerminal(terminalRef.current);
    }
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
    if (terminalRef.current?.id === frame.terminalId) {
      terminalRef.current = {
        ...terminalRef.current,
        sequence: frame.sequence,
        ...(frame.kind === "status"
          ? {
              status:
                frame.status === "interrupted" ? ("interrupted" as const) : ("exited" as const),
              exitCode: frame.exitCode,
            }
          : {}),
      };
      setTerminal(terminalRef.current);
      setOutput(terminalOutputView(frame.terminalId, attachment));
    }
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
      if (instance.binding?.terminalId === value.terminal.terminalId) {
        instance.binding = {
          terminalId: value.terminal.terminalId,
          resourceEpoch: value.resourceEpoch,
        };
      }
      terminalRef.current = terminalView(value.terminal, true);
      setTerminal(terminalRef.current);
      setOutput(terminalOutputView(value.terminal.terminalId, attachment));
      return attachment;
    },
    [instance],
  );

  const attach = useCallback(
    (terminalId: string): Promise<TerminalAttachmentState> => {
      if (instance.closed || instance.binding?.terminalId !== terminalId) {
        return Promise.reject(new Error("终端标签已关闭或绑定已变化。"));
      }
      const existing = attachedJobsRef.current.get(terminalId);
      if (existing) return existing;
      syncingRef.current.add(terminalId);
      markDetached(terminalId);
      overflowedRef.current.delete(terminalId);
      const generation = connectionGenerationRef.current;
      const job = (async () => {
        await ensureTerminalStream();
        if (
          disposedRef.current ||
          instance.closed ||
          generation !== connectionGenerationRef.current
        ) {
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
          if (
            disposedRef.current ||
            instance.closed ||
            generation !== connectionGenerationRef.current
          ) {
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
      instance,
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
        if (
          frame.sessionId !== sessionId ||
          frame.streamId !== streamId ||
          disposedRef.current ||
          instance.closed
        )
          return;
        if (instance.binding && instance.binding.terminalId !== frame.terminalId) return;
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
        setLoading(false);
        markDetached();
        pendingFramesRef.current = [];
        pendingFrameBytesRef.current = 0;
        const terminalId = terminalRef.current?.id;
        if (terminalId && accessRef.current.active) {
          // A read reconnects the shared Runtime request socket and restores its watermark.
          const pending = attachedJobsRef.current.get(terminalId) ?? Promise.resolve();
          void pending
            .catch(() => undefined)
            .then(() => {
              if (
                disposedRef.current ||
                instance.closed ||
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
      initializedRef.current = false;
      subscription.dispose();
      for (const queue of inputQueuesRef.current.values()) queue.dispose();
      inputQueuesRef.current.clear();
      if (instance.closed && !instance.binding && !instance.creation) {
        terminalInstances.delete(terminalBindingKey({ workspacePath, sessionId, instanceId }));
      }
    };
  }, [
    applyFrame,
    bufferFrame,
    instance,
    instanceId,
    markDetached,
    sessionId,
    streamId,
    workspacePath,
  ]);

  const create = useCallback(async () => {
    if (creatingRef.current || disposedRef.current || instance.closed) return;
    if (accessRef.current.readOnly) {
      setError("当前任务只读，不能新建终端。");
      return;
    }
    setLoading(true);
    setError(undefined);
    creatingRef.current = true;
    const generation = connectionGenerationRef.current;
    const current = () =>
      !disposedRef.current && !instance.closed && generation === connectionGenerationRef.current;
    let creation: TerminalInstanceLifecycle["creation"];
    try {
      if (instance.binding) {
        await attach(instance.binding.terminalId);
        return;
      }
      // The lifecycle owns creation across StrictMode replays and actual remounts.
      creation = instance.creation ?? {
        streamId,
        promise: (async () => {
          await ensureTerminalStream();
          if (!current()) return;
          const value = await invokeWorkbarRuntime(runtime, "terminal.create", {
            ...scope,
            streamId,
          });
          instance.binding = {
            terminalId: value.terminal.terminalId,
            resourceEpoch: value.resourceEpoch,
          };
          return value;
        })(),
      };
      instance.creation = creation;
      const value = await creation.promise;
      if (!value) return;
      if (!current()) {
        await invokeWorkbarRuntime(runtime, "terminal.detach", {
          ...scope,
          streamId,
          terminalId: value.terminal.terminalId,
          resourceEpoch: value.resourceEpoch,
        }).catch(() => undefined);
        return;
      }
      if (creation.streamId !== streamId) {
        await attach(value.terminal.terminalId);
        return;
      }
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
      if (current()) setError(workbarErrorMessage(cause));
    } finally {
      if (instance.creation === creation) instance.creation = undefined;
      creatingRef.current = false;
      for (const frame of [...pendingFramesRef.current]) {
        if (!attachmentsRef.current.has(frame.terminalId)) takePendingFrames(frame.terminalId);
      }
      if (!disposedRef.current && generation === connectionGenerationRef.current) setLoading(false);
    }
  }, [
    applyAttachment,
    applyFrame,
    attach,
    ensureTerminalStream,
    instance,
    runtime,
    scope,
    streamId,
    takePendingFrames,
  ]);

  const initialize = useCallback(async () => {
    const generation = connectionGenerationRef.current;
    const current = () =>
      !disposedRef.current && !instance.closed && generation === connectionGenerationRef.current;
    if (!current()) return;
    setLoading(true);
    setError(undefined);
    try {
      await ensureTerminalStream();
      if (!current()) return;
      await instance.creation?.promise;
      if (!current()) return;
      const listed = await invokeWorkbarRuntime(runtime, "terminal.list", scope);
      if (!current()) return;
      const bound = listed.terminals.find(
        (terminal) => terminal.terminalId === instance.binding?.terminalId,
      );
      if (bound) {
        terminalRef.current = terminalView(bound, false);
        setTerminal(terminalRef.current);
        await attach(bound.terminalId);
      } else if (!readOnly) {
        instance.binding = undefined;
        terminalRef.current = undefined;
        setTerminal(undefined);
        setOutput(undefined);
        await create();
      } else {
        instance.binding = undefined;
      }
    } catch (cause) {
      if (current()) setError(workbarErrorMessage(cause));
    } finally {
      if (current()) setLoading(false);
    }
  }, [attach, create, ensureTerminalStream, instance, readOnly, runtime, scope]);

  useEffect(() => {
    if (!active || initializedRef.current) return;
    initializedRef.current = true;
    void initialize();
  }, [active, initialize]);

  const wasActiveRef = useRef(active);
  useEffect(() => {
    const restoring = active && !wasActiveRef.current;
    wasActiveRef.current = active;
    const terminal = terminalRef.current;
    if (restoring && terminal && (!terminal.attached || !attachmentsRef.current.has(terminal.id))) {
      void attach(terminal.id).catch((cause: unknown) => setError(workbarErrorMessage(cause)));
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
        const terminal = terminalRef.current;
        return (
          accessRef.current.active &&
          !accessRef.current.readOnly &&
          !instance.closed &&
          instance.binding?.terminalId === terminalId &&
          terminal?.id === terminalId &&
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
    [instance, markDetached, runtime, scope],
  );

  const resize = useCallback(
    async (terminalId: string, grid: WorkbarTerminalGrid) => {
      if (readOnly || instance.closed || terminalRef.current?.id !== terminalId) return;
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
    [instance, readOnly, runtime, scope, withAttachment],
  );

  return (
    <TerminalWorkbarPanel
      terminal={terminal && terminalTitle ? { ...terminal, title: terminalTitle } : terminal}
      output={output}
      active={active}
      loading={loading}
      readOnly={readOnly}
      error={error}
      onReconnect={() => {
        const terminalId = terminalRef.current?.id;
        void (terminalId ? attach(terminalId) : initialize()).catch((cause: unknown) =>
          setError(workbarErrorMessage(cause)),
        );
      }}
      onInput={input}
      onFocusChange={(focused) => window.pico.terminalFrames.setFocused(focused)}
      onClipboard={(action) => window.pico.terminalFrames.clipboard(action)}
      onResize={(terminalId, grid) => void resize(terminalId, grid)}
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

function terminalInstanceLifecycle(key: string): TerminalInstanceLifecycle {
  let instance = terminalInstances.get(key);
  if (!instance) {
    instance = { closed: false };
    terminalInstances.set(key, instance);
  }
  return instance;
}

function isEpochConflict(cause: unknown): boolean {
  return (
    cause instanceof WorkbarPanelRuntimeError &&
    (cause.code === "CONFLICT" || cause.message.toLowerCase().includes("epoch"))
  );
}
