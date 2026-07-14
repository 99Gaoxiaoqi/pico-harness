import { describe, expect, expectTypeOf, it } from "vitest";
import {
  createRuntimeEvent as createCompatibleEvent,
  LOCAL_RUNTIME_PROTOCOL_VERSION as compatibleVersion,
} from "../../src/daemon/protocol.js";
import {
  createRuntimeEvent,
  createRuntimeRequest,
  createTypedRuntimeRequest,
  encodeRuntimeFrame,
  LOCAL_RUNTIME_PROTOCOL_VERSION,
  MAX_RUNTIME_FRAME_BYTES,
  parseRuntimeMessage,
  parseRuntimeParams,
  RUNTIME_ERROR_CODES,
  RUNTIME_METHODS,
  RuntimeFrameDecoder,
  RuntimeProtocolError,
  type RuntimeEventMap,
  type RuntimeMethodMap,
  type RuntimeParams,
  type RuntimeResult,
} from "../../packages/protocol/src/index.js";

describe("desktop runtime protocol contract", () => {
  it("keeps protocol v1 and the daemon compatibility import surface", () => {
    expect(LOCAL_RUNTIME_PROTOCOL_VERSION).toBe(1);
    expect(compatibleVersion).toBe(LOCAL_RUNTIME_PROTOCOL_VERSION);
    expect(
      createCompatibleEvent({
        eventId: "compat-event",
        topic: "runtime.compatibility",
        scope: { workspacePath: "/tmp" },
        resourceVersion: 1,
        at: 1,
        payload: {},
      }),
    ).toEqual(
      createRuntimeEvent({
        eventId: "compat-event",
        topic: "runtime.compatibility",
        scope: { workspacePath: "/tmp" },
        resourceVersion: 1,
        at: 1,
        payload: {},
      }),
    );
    expect(MAX_RUNTIME_FRAME_BYTES).toBe(1024 * 1024);
  });

  it("publishes the complete desktop method registry without dropping v1 methods", () => {
    expect(RUNTIME_METHODS).toEqual(
      expect.arrayContaining([
        "runtime.ping",
        "session.list",
        "session.rename",
        "session.fork",
        "session.compact",
        "session.send",
        "session.transcript",
        "run.start",
        "run.pause",
        "run.resume",
        "approval.respond",
        "prompt.respond",
        "changes.diff",
        "changes.review",
        "changes.apply",
        "rewind.preview",
        "rewind.apply",
        "jobs.list",
        "jobs.create",
        "config.get",
        "usage.get",
        "workspace.register",
        "workspace.status",
        "events.replay",
        "events.subscribe",
      ]),
    );
  });

  it("rejects unknown methods and non-object params with stable error codes", () => {
    expectProtocolError(
      () => parseRuntimeMessage(requestJson("unknown.method", {})),
      RUNTIME_ERROR_CODES.METHOD_NOT_FOUND,
    );
    expectProtocolError(
      () => parseRuntimeMessage(requestJson("runtime.ping", [])),
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
    );
    expectProtocolError(
      () => parseRuntimeMessage(requestJson("runtime.ping", "probe")),
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
    );
    expectProtocolError(
      () => parseRuntimeParams("runtime.ping", Number.NaN),
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
    );
  });

  it("parses legacy v1 requests while preserving object params", () => {
    const parsed = parseRuntimeMessage(requestJson("workspace.status", { workspacePath: "/tmp" }));
    expect(parsed).toMatchObject({
      kind: "request",
      protocolVersion: 1,
      method: "workspace.status",
      params: { workspacePath: "/tmp" },
    });
    expect(() => createRuntimeRequest("runtime.ping", [])).toThrowError(
      expect.objectContaining({ code: RUNTIME_ERROR_CODES.INVALID_PARAMS }),
    );
  });

  it("decodes fragmented frames and rejects frames beyond 1 MB", () => {
    const request = createRuntimeRequest("runtime.ping", { probe: true });
    const frame = encodeRuntimeFrame(request);
    const decoder = new RuntimeFrameDecoder();
    expect(decoder.push(frame.subarray(0, 3))).toEqual([]);
    expect(decoder.push(frame.subarray(3))).toEqual([request]);

    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(MAX_RUNTIME_FRAME_BYTES + 1, 0);
    expectProtocolError(
      () => new RuntimeFrameDecoder().push(oversized),
      RUNTIME_ERROR_CODES.FRAME_TOO_LARGE,
    );
    expectProtocolError(
      () =>
        encodeRuntimeFrame(
          createRuntimeRequest("runtime.ping", { payload: "x".repeat(MAX_RUNTIME_FRAME_BYTES) }),
        ),
      RUNTIME_ERROR_CODES.FRAME_TOO_LARGE,
    );
  });

  it("exposes method and event maps for end-to-end type inference", () => {
    type StartParams = RuntimeParams<"run.start">;
    type StartResult = RuntimeResult<"run.start">;
    type ApprovalPayload = RuntimeEventMap["approval.requested"];
    type SessionSendParams = RuntimeParams<"session.send">;
    type TranscriptResult = RuntimeResult<"session.transcript">;
    type CompactResult = RuntimeResult<"session.compact">;

    expectTypeOf<StartParams>().toMatchTypeOf<{
      workspacePath: string;
      prompt: string;
    }>();
    expectTypeOf<StartResult["runId"]>().toMatchTypeOf<string>();
    expectTypeOf<ApprovalPayload["request"]>().toMatchTypeOf<Record<string, unknown>>();
    expectTypeOf<SessionSendParams["behavior"]>().toEqualTypeOf<
      "auto" | "steer" | "queue" | "replace" | undefined
    >();
    expectTypeOf<TranscriptResult["revision"]>().toEqualTypeOf<string>();
    expectTypeOf<CompactResult["compacted"]>().toEqualTypeOf<true>();
    expectTypeOf<keyof RuntimeMethodMap>().toEqualTypeOf<(typeof RUNTIME_METHODS)[number]>();

    const request = createTypedRuntimeRequest("run.start", {
      workspacePath: "/tmp/project",
      prompt: "fix tests",
    });
    expectTypeOf(request.method).toEqualTypeOf<"run.start">();
    expect(request.params.prompt).toBe("fix tests");
  });
});

function requestJson(method: string, params: unknown): string {
  return JSON.stringify({
    kind: "request",
    protocolVersion: 1,
    requestId: "request-1",
    method,
    params,
  });
}

function expectProtocolError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected protocol error");
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeProtocolError);
    expect(error).toMatchObject({ code });
  }
}
