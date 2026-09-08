import type { RuntimeResult, RuntimeTerminalSession } from "@pico/protocol";
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

const TERMINAL_POLL_MS = 400;

const TERMINAL_ATTACH_BYTES = 64 * 1024;

const TERMINAL_OUTPUT_BYTES = 512 * 1024;

interface TerminalAttachmentState {
  readonly epoch: string;
  readonly sequence: number;
  readonly text: string;
  readonly truncated: boolean;
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
      const attached = await invokeWorkbarRuntime(runtime, "terminal.attach", {
        workspacePath: scope.workspacePath,
        sessionId: scope.sessionId,
        terminalId,
        maxBytes: 1,
      });
      await invokeWorkbarRuntime(runtime, "terminal.stop", {
        workspacePath: scope.workspacePath,
        sessionId: scope.sessionId,
        terminalId,
        resourceEpoch: attached.resourceEpoch,
      });
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
  const scope = useMemo(() => ({ workspacePath, sessionId }), [workspacePath, sessionId]);
  const [terminals, setTerminals] = useState<readonly WorkbarTerminalInstance[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string>();
  const [output, setOutput] = useState<WorkbarTerminalOutput>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [pollingActive, setPollingActive] = useState(false);
  const initializedRef = useRef(false);
  const activeTerminalIdRef = useRef<string | undefined>(undefined);
  const attachmentsRef = useRef(new Map<string, TerminalAttachmentState>());
  const pollInFlightRef = useRef(false);

  const applyAttachment = useCallback(
    (
      value: RuntimeResult<"terminal.attach"> | RuntimeResult<"terminal.create">,
      replace: boolean,
    ) => {
      const current = attachmentsRef.current.get(value.terminal.terminalId);
      const text = replace
        ? value.snapshot
        : appendTerminalOutput(current?.text ?? "", value.snapshot, TERMINAL_OUTPUT_BYTES);
      const attachment = {
        epoch: value.resourceEpoch,
        sequence: value.sequence,
        text,
        truncated: value.truncated || current?.truncated === true,
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
    async (terminalId: string, incremental = false) => {
      const current = attachmentsRef.current.get(terminalId);
      let value: RuntimeResult<"terminal.attach">;
      try {
        value = await invokeWorkbarRuntime(runtime, "terminal.attach", {
          ...scope,
          terminalId,
          maxBytes: TERMINAL_ATTACH_BYTES,
          ...(incremental && current ? { afterSequence: current.sequence } : {}),
        });
      } catch (cause) {
        if (!incremental || !current || !isEpochConflict(cause)) throw cause;
        value = await invokeWorkbarRuntime(runtime, "terminal.attach", {
          ...scope,
          terminalId,
          maxBytes: TERMINAL_ATTACH_BYTES,
        });
        return applyAttachment(value, true);
      }
      if (incremental && current && value.resourceEpoch !== current.epoch) {
        value = await invokeWorkbarRuntime(runtime, "terminal.attach", {
          ...scope,
          terminalId,
          maxBytes: TERMINAL_ATTACH_BYTES,
        });
        return applyAttachment(value, true);
      }
      return applyAttachment(value, !incremental || !current);
    },
    [applyAttachment, runtime, scope],
  );

  const create = useCallback(async () => {
    if (readOnly) {
      setError("当前任务只读，不能新建终端。");
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const value = await invokeWorkbarRuntime(runtime, "terminal.create", scope);
      bindTerminalToInstance(
        { workspacePath, sessionId, instanceId },
        value.terminal.terminalId,
        value.resourceEpoch,
      );
      activeTerminalIdRef.current = value.terminal.terminalId;
      setActiveTerminalId(value.terminal.terminalId);
      applyAttachment(value, true);
    } catch (cause) {
      setError(workbarErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [applyAttachment, instanceId, readOnly, runtime, scope, sessionId, workspacePath]);

  const initialize = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
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
  }, [attach, create, instanceId, readOnly, runtime, scope, sessionId, workspacePath]);

  useEffect(() => {
    if (!active || initializedRef.current) return;
    initializedRef.current = true;
    void initialize();
  }, [active, initialize]);

  useEffect(() => {
    if (!active || !pollingActive || !activeTerminalId) return;
    const poll = () => {
      if (pollInFlightRef.current) return;
      pollInFlightRef.current = true;
      void attach(activeTerminalId, true)
        .catch((cause: unknown) => setError(workbarErrorMessage(cause)))
        .finally(() => {
          pollInFlightRef.current = false;
        });
    };
    poll();
    const interval = window.setInterval(poll, TERMINAL_POLL_MS);
    return () => window.clearInterval(interval);
  }, [active, activeTerminalId, attach, pollingActive]);

  useEffect(
    () => () => {
      for (const [terminalId, attachment] of attachmentsRef.current) {
        void invokeWorkbarRuntime(runtime, "terminal.detach", {
          ...scope,
          terminalId,
          resourceEpoch: attachment.epoch,
        }).catch(() => undefined);
      }
      attachmentsRef.current.clear();
    },
    [runtime, scope],
  );

  const select = useCallback(
    (terminalId: string) => {
      activeTerminalIdRef.current = terminalId;
      setActiveTerminalId(terminalId);
      const attachment = attachmentsRef.current.get(terminalId);
      setOutput(attachment ? terminalOutputView(terminalId, attachment) : undefined);
      if (!attachment && active) {
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
    async (terminalId: string, data: string) => {
      if (readOnly) {
        setError("当前任务只读，不能写入终端。");
        return;
      }
      setError(undefined);
      try {
        await withAttachment(terminalId, async (attachment) => {
          await invokeWorkbarRuntime(runtime, "terminal.input", {
            ...scope,
            terminalId,
            resourceEpoch: attachment.epoch,
            data: data.endsWith("\n") || data.endsWith("\r") ? data : `${data}\r`,
          });
        });
      } catch (cause) {
        setError(workbarErrorMessage(cause));
      }
    },
    [readOnly, runtime, scope, withAttachment],
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
      error={error}
      onCreate={() => void create()}
      onSelect={select}
      onAttach={(terminalId) =>
        void attach(terminalId).catch((cause: unknown) => setError(workbarErrorMessage(cause)))
      }
      onInput={(terminalId, data) => void input(terminalId, data)}
      onResize={(terminalId, grid) => void resize(terminalId, grid)}
      onStop={(terminalId) => void stop(terminalId)}
      onSetPollingActive={setPollingActive}
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
