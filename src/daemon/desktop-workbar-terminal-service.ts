import {
  WorkbarTerminalAuthority,
  WorkbarTerminalError,
  type WorkbarTerminalAttachment,
  type WorkbarTerminalRecord,
} from "@pico/runtime-host";
import { FileWorkbarTerminalStateStore } from "./workbar-terminal-state-store.js";

const DEFAULT_SNAPSHOT_BYTES = 256 * 1024;

export class DesktopWorkbarTerminalService {
  private readonly authority: WorkbarTerminalAuthority;
  private readonly ready: Promise<void>;

  constructor(options: { readonly picoHome: string }) {
    this.authority = new WorkbarTerminalAuthority({
      store: new FileWorkbarTerminalStateStore({ picoHome: options.picoHome }),
    });
    this.ready = this.authority.recover();
  }

  async create(input: {
    readonly workspacePath: string;
    readonly sessionId: string;
    readonly cols?: number;
    readonly rows?: number;
  }) {
    await this.ready;
    const attachment = await this.authority.create(input);
    return this.attachmentResult(
      this.authority.attach({
        resourceId: attachment.resourceId,
        resourceEpoch: attachment.resourceEpoch,
        attachmentId: attachmentId(input.sessionId, attachment.resourceId),
      }),
      DEFAULT_SNAPSHOT_BYTES,
    );
  }

  async list(owner: { readonly workspacePath: string; readonly sessionId: string }) {
    await this.ready;
    return {
      terminals: (await this.authority.list(owner)).map(runtimeTerminal),
    };
  }

  async attach(input: {
    readonly workspacePath: string;
    readonly sessionId: string;
    readonly terminalId: string;
    readonly afterSequence?: number;
    readonly maxBytes?: number;
  }) {
    await this.ready;
    const record = await this.ownedRecord(input);
    const attachment = this.authority.attach({
      resourceId: record.resourceId,
      resourceEpoch: record.resourceEpoch,
      attachmentId: attachmentId(input.sessionId, record.resourceId),
      ...(input.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }),
    });
    return this.attachmentResult(
      attachment,
      Math.min(input.maxBytes ?? DEFAULT_SNAPSHOT_BYTES, DEFAULT_SNAPSHOT_BYTES),
    );
  }

  async input(input: {
    readonly workspacePath: string;
    readonly sessionId: string;
    readonly terminalId: string;
    readonly resourceEpoch: string;
    readonly data: string;
  }) {
    await this.ready;
    const record = await this.ownedRecord(input);
    assertEpoch(record, input.resourceEpoch);
    this.authority.input({
      resourceId: record.resourceId,
      resourceEpoch: record.resourceEpoch,
      data: input.data,
    });
    return { accepted: true as const, sequence: record.sequence };
  }

  async resize(input: {
    readonly workspacePath: string;
    readonly sessionId: string;
    readonly terminalId: string;
    readonly resourceEpoch: string;
    readonly cols: number;
    readonly rows: number;
  }) {
    await this.ready;
    const record = await this.ownedRecord(input);
    assertEpoch(record, input.resourceEpoch);
    const resized = await this.authority.resize({
      resourceId: record.resourceId,
      resourceEpoch: record.resourceEpoch,
      cols: input.cols,
      rows: input.rows,
    });
    return { resized: true as const, sequence: resized.sequence };
  }

  async stop(input: {
    readonly workspacePath: string;
    readonly sessionId: string;
    readonly terminalId: string;
    readonly resourceEpoch: string;
  }) {
    await this.ready;
    const record = await this.ownedRecord(input);
    assertEpoch(record, input.resourceEpoch);
    return {
      terminal: runtimeTerminal(
        await this.authority.stop({
          resourceId: record.resourceId,
          resourceEpoch: record.resourceEpoch,
        }),
      ),
    };
  }

  async detach(input: {
    readonly workspacePath: string;
    readonly sessionId: string;
    readonly terminalId: string;
    readonly resourceEpoch: string;
  }) {
    await this.ready;
    const record = await this.ownedRecord(input);
    assertEpoch(record, input.resourceEpoch);
    this.authority.detach({
      resourceId: record.resourceId,
      attachmentId: attachmentId(input.sessionId, record.resourceId),
    });
    return { detached: true as const };
  }

  async stopSession(owner: { readonly workspacePath: string; readonly sessionId: string }) {
    await this.ready;
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

  async close(): Promise<void> {
    await this.ready.catch(() => undefined);
    await this.authority.close();
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

  private attachmentResult(attachment: WorkbarTerminalAttachment, maxBytes: number) {
    const output = attachment.events
      .filter((event) => event.kind === "output")
      .map((event) => event.data)
      .join("");
    const snapshot = tailUtf8(output, maxBytes);
    return {
      terminal: runtimeTerminal(attachment),
      resourceEpoch: attachment.resourceEpoch,
      sequence: attachment.sequence,
      snapshot: snapshot.value,
      truncated: attachment.truncated || snapshot.truncated,
    };
  }
}

function runtimeTerminal(record: WorkbarTerminalRecord) {
  return {
    terminalId: record.resourceId,
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
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
    capability: record.capability,
    resizeSupported: record.resizeSupported,
    cwd: record.cwd,
  };
}

function attachmentId(sessionId: string, resourceId: string): string {
  return `desktop:${sessionId}:${resourceId}`;
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
