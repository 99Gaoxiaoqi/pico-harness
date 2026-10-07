import { realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  WorkbarTerminalAuthority,
  WorkbarTerminalError,
  type WorkbarTerminalEvent,
  type WorkbarTerminalAttachment,
  type WorkbarTerminalRecord,
} from "@pico/runtime-host";
import type { RuntimeTerminalFrame } from "@pico/protocol";
import { FileWorkbarTerminalStateStore } from "./workbar-terminal-state-store.js";

// Host assembly: Runtime Host owns terminal primitives; Pico Host owns Session scoping.

export interface TerminalClientContext {
  readonly terminalOwnerId: string;
  /** Legacy local hello uses exact old terminal response shapes. */
  readonly legacyWire?: boolean;
  readonly terminalAttachmentId: string;
  readonly terminalConnectionId?: string;
  readonly terminalStreamId?: string;
  readonly pushTerminalFrame?: (frame: RuntimeTerminalFrame) => Promise<void>;
  readonly surface: "desktop" | "tui" | "run" | "activation" | "bot" | "inspect";
}

const LEGACY_CONTEXT: TerminalClientContext = {
  terminalOwnerId: "desktop:legacy",
  terminalAttachmentId: "desktop:legacy",
  surface: "desktop",
  legacyWire: true,
};

const DEFAULT_SNAPSHOT_BYTES = 256 * 1024;
const MAX_CONNECTION_ATTACHMENTS = 32;

interface AttachmentLease {
  pending: number;
  attached: boolean;
}

interface ConnectionAttachments {
  readonly connectionId: string;
  readonly resources: Map<string, AttachmentLease>;
}

export class DesktopWorkbarTerminalService {
  private readonly authority: WorkbarTerminalAuthority;
  private readonly attachments = new Map<string, ConnectionAttachments>();
  private readonly streams = new Map<
    string,
    Map<
      string,
      {
        readonly sessionId: string;
        readonly streamId?: string;
        readonly push: (frame: RuntimeTerminalFrame) => Promise<void>;
      }
    >
  >();
  private readonly ready: Promise<void>;
  private readonly pendingSessionCreates = new Map<string, number>();
  private readonly resolvingSessionCreates = new Map<string, number>();
  private readonly cleaningSessions = new Set<string>();

  constructor(options: { readonly picoHome: string }) {
    this.authority = new WorkbarTerminalAuthority({
      store: new FileWorkbarTerminalStateStore({ picoHome: options.picoHome }),
      onEvent: (event, attachmentIds) => this.publishFrame(event, attachmentIds),
    });
    this.ready = this.authority.recover();
  }

  async create(
    input: {
      readonly workspacePath: string;
      readonly sessionId: string;
      readonly cols?: number;
      readonly rows?: number;
    },
    context: TerminalClientContext = LEGACY_CONTEXT,
  ) {
    return this.withAttachment(context, undefined, async (commit) => {
      await this.ready;
      // Mark starting creates before their path-resolution await; cleanup must also see this gap.
      this.resolvingSessionCreates.set(
        input.sessionId,
        (this.resolvingSessionCreates.get(input.sessionId) ?? 0) + 1,
      );
      let normalizedInput: typeof input;
      try {
        normalizedInput = { ...input, workspacePath: await realpath(input.workspacePath) };
      } finally {
        const pending = (this.resolvingSessionCreates.get(input.sessionId) ?? 1) - 1;
        if (pending) this.resolvingSessionCreates.set(input.sessionId, pending);
        else this.resolvingSessionCreates.delete(input.sessionId);
      }
      const key = sessionKey(normalizedInput);
      if (this.cleaningSessions.has(key)) {
        throw new WorkbarTerminalError("forbidden", "Session cleanup is in progress");
      }
      this.pendingSessionCreates.set(key, (this.pendingSessionCreates.get(key) ?? 0) + 1);
      let attachment: WorkbarTerminalAttachment;
      try {
        attachment = await this.authority.create({
          ...normalizedInput,
          terminalOwnerId: context.terminalOwnerId,
        });
      } finally {
        const pending = (this.pendingSessionCreates.get(key) ?? 1) - 1;
        if (pending) this.pendingSessionCreates.set(key, pending);
        else this.pendingSessionCreates.delete(key);
      }
      commit(attachment.resourceId);
      this.registerStream(context, attachment.resourceId, attachment.sessionId);
      return this.attachmentResult(
        this.authority.attach({
          resourceId: attachment.resourceId,
          resourceEpoch: attachment.resourceEpoch,
          attachmentId: context.terminalAttachmentId,
        }),
        DEFAULT_SNAPSHOT_BYTES,
        context,
      );
    });
  }

  async list(
    owner: { readonly workspacePath: string; readonly sessionId: string },
    context: TerminalClientContext = LEGACY_CONTEXT,
  ) {
    await this.ready;
    return {
      terminals: (await this.authority.list(owner)).map((record) =>
        runtimeTerminal(record, context),
      ),
    };
  }

  async attach(
    input: {
      readonly workspacePath: string;
      readonly sessionId: string;
      readonly terminalId: string;
      readonly afterSequence?: number;
      readonly maxBytes?: number;
    },
    context: TerminalClientContext = LEGACY_CONTEXT,
  ) {
    return this.withAttachment(context, input.terminalId, async (commit) => {
      await this.ready;
      const record = await this.ownedRecord(input);
      commit(record.resourceId);
      this.registerStream(context, record.resourceId, record.sessionId);
      const attachment = this.authority.attach({
        resourceId: record.resourceId,
        resourceEpoch: record.resourceEpoch,
        attachmentId: context.terminalAttachmentId,
        ...(input.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }),
      });
      return this.attachmentResult(
        attachment,
        Math.min(input.maxBytes ?? DEFAULT_SNAPSHOT_BYTES, DEFAULT_SNAPSHOT_BYTES),
        context,
      );
    });
  }

  async input(
    input: {
      readonly workspacePath: string;
      readonly sessionId: string;
      readonly terminalId: string;
      readonly resourceEpoch: string;
      readonly data: string;
    },
    context: TerminalClientContext = LEGACY_CONTEXT,
  ) {
    await this.ready;
    const record = await this.ownedRecord(input);
    assertControl(record, context);
    assertEpoch(record, input.resourceEpoch);
    this.authority.input({
      resourceId: record.resourceId,
      resourceEpoch: record.resourceEpoch,
      data: input.data,
    });
    return { accepted: true as const, sequence: record.sequence };
  }

  async resize(
    input: {
      readonly workspacePath: string;
      readonly sessionId: string;
      readonly terminalId: string;
      readonly resourceEpoch: string;
      readonly cols: number;
      readonly rows: number;
    },
    context: TerminalClientContext = LEGACY_CONTEXT,
  ) {
    await this.ready;
    const record = await this.ownedRecord(input);
    assertControl(record, context);
    assertEpoch(record, input.resourceEpoch);
    const resized = await this.authority.resize({
      resourceId: record.resourceId,
      resourceEpoch: record.resourceEpoch,
      cols: input.cols,
      rows: input.rows,
    });
    return { resized: true as const, sequence: resized.sequence };
  }

  async stop(
    input: {
      readonly workspacePath: string;
      readonly sessionId: string;
      readonly terminalId: string;
      readonly resourceEpoch: string;
    },
    context: TerminalClientContext = LEGACY_CONTEXT,
  ) {
    await this.ready;
    const record = await this.ownedRecord(input);
    assertControl(record, context);
    assertEpoch(record, input.resourceEpoch);
    return {
      terminal: runtimeTerminal(
        await this.authority.stop({
          resourceId: record.resourceId,
          resourceEpoch: record.resourceEpoch,
        }),
        context,
      ),
    };
  }

  async detach(
    input: {
      readonly workspacePath: string;
      readonly sessionId: string;
      readonly terminalId: string;
      readonly resourceEpoch: string;
    },
    context: TerminalClientContext = LEGACY_CONTEXT,
  ) {
    await this.ready;
    const record = await this.ownedRecord(input);
    assertEpoch(record, input.resourceEpoch);
    this.authority.detach({
      resourceId: record.resourceId,
      attachmentId: context.terminalAttachmentId,
    });
    const attachments = this.attachments.get(context.terminalAttachmentId);
    attachments?.resources.delete(record.resourceId);
    if (attachments?.resources.size === 0) this.attachments.delete(context.terminalAttachmentId);
    this.streams.get(context.terminalAttachmentId)?.delete(record.resourceId);
    if (this.streams.get(context.terminalAttachmentId)?.size === 0)
      this.streams.delete(context.terminalAttachmentId);
    return { detached: true as const };
  }

  /** Remote Session permissions never imply permission to stop a Shell, including one's own. */
  async withSessionCleanup<Result>(
    workspacePath: string,
    sessionIds: readonly string[],
    context: TerminalClientContext | undefined,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    if (!isRemoteTerminalContext(context)) return operation();
    await this.ready;
    const owners = sessionIds.map((sessionId) => ({ workspacePath, sessionId }));
    const keys = owners.map(sessionKey);
    if (keys.some((key) => this.cleaningSessions.has(key))) {
      throw new WorkbarTerminalError("forbidden", "Session cleanup is already in progress");
    }
    for (const key of keys) this.cleaningSessions.add(key);
    try {
      // Lock all target admissions before checking any target, avoiding partial child cleanup.
      for (const owner of owners) await this.assertSessionCleanupAllowed(owner, context);
      return await operation();
    } finally {
      for (const key of keys) this.cleaningSessions.delete(key);
    }
  }

  async assertSessionCleanupAllowed(
    owner: { readonly workspacePath: string; readonly sessionId: string },
    context?: TerminalClientContext,
  ): Promise<void> {
    if (!isRemoteTerminalContext(context)) return;
    await this.ready;
    const terminals = await this.authority.list(owner);
    if (
      this.resolvingSessionCreates.has(owner.sessionId) ||
      this.pendingSessionCreates.has(sessionKey(owner)) ||
      terminals.some((terminal) => terminal.status === "running")
    ) {
      throw new WorkbarTerminalError(
        "forbidden",
        "Session has an active or starting terminal; explicitly stop it with terminal.stop first",
      );
    }
  }

  async stopSession(
    owner: { readonly workspacePath: string; readonly sessionId: string },
    context?: TerminalClientContext,
  ) {
    await this.ready;
    await this.assertSessionCleanupAllowed(owner, context);
    // Even after admission changes, a remote cleanup must never call the Shell stop primitive.
    if (isRemoteTerminalContext(context)) return;
    const terminals = await this.authority.list(owner);
    await Promise.all(
      terminals
        .filter((terminal) => terminal.status === "running")
        .map((terminal) =>
          this.authority.stop({
            resourceId: terminal.resourceId,
            resourceEpoch: terminal.resourceEpoch,
          }),
        ),
    );
  }

  async stopAll() {
    await this.ready;
    return { stopped: await this.authority.stopAll() };
  }

  async stopOwned(context: TerminalClientContext = LEGACY_CONTEXT) {
    await this.ready;
    return {
      stopped: await this.authority.stopOwned(
        context.terminalOwnerId,
        context.surface === "desktop",
      ),
    };
  }

  releaseAttachment(attachmentId: string): void {
    for (const key of this.attachments.keys()) {
      if (key !== attachmentId && !key.startsWith(`${attachmentId}:`)) continue;
      this.attachments.delete(key);
      this.authority.detachAttachment(key);
    }
    for (const key of this.streams.keys()) {
      if (key !== attachmentId && !key.startsWith(`${attachmentId}:`)) continue;
      this.streams.delete(key);
      this.authority.detachAttachment(key);
    }
    this.authority.detachAttachment(attachmentId);
  }

  async resume(context?: TerminalClientContext) {
    await this.ready;
    if (context) this.authority.resumeOwner(context.terminalOwnerId, context.surface === "desktop");
    else this.authority.resumeCreates();
    return { accepting: true as const };
  }

  async close(): Promise<void> {
    this.attachments.clear();
    await this.ready.catch(() => undefined);
    this.streams.clear();
    await this.authority.close();
  }

  private async withAttachment<Result>(
    context: TerminalClientContext,
    terminalId: string | undefined,
    operation: (commit: (terminalId: string) => void) => Promise<Result>,
  ): Promise<Result> {
    const attachmentId = context.terminalAttachmentId;
    const connectionId = context.terminalConnectionId ?? attachmentId;
    const key = terminalId ?? `pending:${randomUUID()}`;
    let attachments = this.attachments.get(attachmentId);
    let lease = attachments?.resources.get(key);
    if (!lease) {
      let count = 0;
      for (const entry of this.attachments.values())
        if (entry.connectionId === connectionId) count += entry.resources.size;
      if (count >= MAX_CONNECTION_ATTACHMENTS)
        throw new WorkbarTerminalError(
          "capacity_exceeded",
          "Terminal display capacity is exhausted",
        );
      if (!attachments) {
        attachments = { connectionId, resources: new Map() };
        this.attachments.set(attachmentId, attachments);
      }
      lease = { pending: 0, attached: false };
      attachments.resources.set(key, lease);
    }
    const admitted = attachments!;
    const reservation = lease;
    reservation.pending++;
    try {
      return await operation((resourceId) => {
        // releaseAttachment also invalidates opens abandoned by the Host operation deadline.
        if (
          this.attachments.get(attachmentId) !== admitted ||
          admitted.resources.get(key) !== reservation
        )
          throw new WorkbarTerminalError(
            "admission_closed",
            "Terminal display connection is closed",
          );
        if (resourceId === key) reservation.attached = true;
        else {
          const existing = admitted.resources.get(resourceId);
          if (existing) existing.attached = true;
          else {
            reservation.attached = true;
            admitted.resources.delete(key);
            admitted.resources.set(resourceId, reservation);
          }
        }
      });
    } finally {
      reservation.pending--;
      if (
        !reservation.pending &&
        !reservation.attached &&
        admitted.resources.get(key) === reservation
      )
        admitted.resources.delete(key);
      if (!admitted.resources.size && this.attachments.get(attachmentId) === admitted)
        this.attachments.delete(attachmentId);
    }
  }

  private async ownedRecord(input: {
    readonly workspacePath: string;
    readonly sessionId: string;
    readonly terminalId: string;
  }): Promise<WorkbarTerminalRecord> {
    const record = (await this.authority.list(input)).find(
      (terminal) => terminal.resourceId === input.terminalId,
    );
    if (!record) throw new WorkbarTerminalError("not_found", "Terminal does not belong to Session");
    return record;
  }

  private registerStream(
    context: TerminalClientContext,
    terminalId: string,
    sessionId: string,
  ): void {
    if (!context.pushTerminalFrame) return;
    let streams = this.streams.get(context.terminalAttachmentId);
    if (!streams) {
      streams = new Map();
      this.streams.set(context.terminalAttachmentId, streams);
    }
    streams.set(terminalId, {
      sessionId,
      ...(context.terminalStreamId ? { streamId: context.terminalStreamId } : {}),
      push: context.pushTerminalFrame,
    });
  }

  private publishFrame(event: WorkbarTerminalEvent, attachmentIds: readonly string[]): void {
    for (const attachmentId of attachmentIds) {
      const stream = this.streams.get(attachmentId)?.get(event.resourceId);
      if (!stream) continue;
      const { resourceId, ...payload } = event;
      const frame = {
        type: "terminal.event" as const,
        terminalId: resourceId,
        sessionId: stream.sessionId,
        ...(stream.streamId ? { streamId: stream.streamId } : {}),
        ...payload,
      };
      void stream.push(frame).catch(() => this.releaseAttachment(attachmentId));
    }
  }

  private attachmentResult(
    attachment: WorkbarTerminalAttachment,
    maxBytes: number,
    context: TerminalClientContext,
  ) {
    const output = attachment.events
      .filter((event) => event.kind === "output")
      .map((event) => event.data)
      .join("");
    const snapshot = tailUtf8(output, maxBytes);
    return {
      terminal: runtimeTerminal(attachment, context),
      resourceEpoch: attachment.resourceEpoch,
      sequence: attachment.sequence,
      snapshot: snapshot.value,
      truncated: attachment.truncated || snapshot.truncated,
    };
  }
}

function runtimeTerminal(
  record: WorkbarTerminalRecord,
  context: TerminalClientContext = LEGACY_CONTEXT,
) {
  return {
    terminalId: record.resourceId,
    ...(context.legacyWire
      ? {}
      : {
          terminalOwnerId: record.terminalOwnerId ?? "desktop:legacy",
          controlAllowed: canControl(record, context),
        }),
    workspacePath: record.workspacePath,
    sessionId: record.sessionId,
    resourceEpoch: record.resourceEpoch,
    sequence: record.sequence,
    status:
      record.status === "stopped"
        ? ("exited" as const)
        : record.status === "running"
          ? ("running" as const)
          : record.status,
    capability: record.capability,
    resizeSupported: record.resizeSupported,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
  };
}

function canControl(record: WorkbarTerminalRecord, context: TerminalClientContext): boolean {
  const owner = record.terminalOwnerId ?? "desktop:legacy";
  return (
    owner === context.terminalOwnerId ||
    (owner === "desktop:legacy" && context.surface === "desktop")
  );
}

function assertControl(record: WorkbarTerminalRecord, context: TerminalClientContext): void {
  if (!canControl(record, context))
    throw new WorkbarTerminalError("forbidden", "Terminal belongs to another client");
}

function assertEpoch(record: WorkbarTerminalRecord, expected: string): void {
  if (record.resourceEpoch !== expected) {
    throw new WorkbarTerminalError(
      "resource_epoch_mismatch",
      "Terminal epoch changed; attach again",
    );
  }
}

function tailUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= maxBytes) return { value, truncated: false };
  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return { value: bytes.subarray(start).toString("utf8"), truncated: true };
}

export function isRemoteTerminalContext(context?: TerminalClientContext): boolean {
  return context?.surface === "inspect" && context.terminalOwnerId.startsWith("remote:");
}

function sessionKey(owner: { readonly workspacePath: string; readonly sessionId: string }): string {
  return JSON.stringify([owner.workspacePath, owner.sessionId]);
}
