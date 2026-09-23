/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

// Adapted from Maka's archive resource protocol; Pico keeps the original body in its ledger.
import { createHash } from "node:crypto";
import { type RuntimeToolResultRecordedEvent } from "@pico/core";
import type { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";

export const TOOL_RESULT_ARCHIVE_MAX_LIMIT = 6_000;
export const TOOL_RESULT_ARCHIVE_MAX_RESPONSE_CHARS = 7_500;
export const TOOL_RESULT_ARCHIVE_THRESHOLD_CHARS = 2_048 * 4;
export interface ToolResultArchiveIdentity {
  sessionId: string;
  eventId: string;
  sha256: string;
  sizeBytes: number;
}
export function buildToolResultArchiveRef(identity: ToolResultArchiveIdentity): string {
  return `pico://archive/${encodeURIComponent(identity.sessionId)}/${encodeURIComponent(identity.eventId)}/${identity.sha256}/${identity.sizeBytes}`;
}
export function parseToolResultArchiveRef(ref: string): ToolResultArchiveIdentity | null {
  try {
    const url = new URL(ref);
    if (
      url.protocol !== "pico:" ||
      url.hostname !== "archive" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    )
      return null;
    const parts = url.pathname.split("/");
    if (parts.length !== 5 || parts[0] !== "") return null;
    const sessionId = decodeURIComponent(parts[1]!);
    const eventId = decodeURIComponent(parts[2]!);
    const sha256 = parts[3]!;
    const sizeBytes = Number(parts[4]);
    if (
      !sessionId ||
      !eventId ||
      !/^[a-f0-9]{64}$/.test(sha256) ||
      !/^[1-9][0-9]*$/.test(parts[4]!) ||
      !Number.isSafeInteger(sizeBytes)
    )
      return null;
    const identity = { sessionId, eventId, sha256, sizeBytes };
    return buildToolResultArchiveRef(identity) === ref ? identity : null;
  } catch {
    return null;
  }
}

/** Build a replacement only. Callers must commit its transition before replay.
 * Original bodies stay in the ledger; recovery guidance and archive reads remain intact.
 */
export function archiveRuntimeToolResult(
  event: RuntimeToolResultRecordedEvent,
  options: { force?: boolean; supersededByToolCallId?: string; reason?: string } = {},
): RuntimeToolResultRecordedEvent {
  const { body, projection } = event.data;
  if (
    event.data.toolName === "archive_read" ||
    (event.data.toolName === "read_file" &&
      projection.text.startsWith('{"kind":"tool_result_archive",')) ||
    body.storage !== "inline" ||
    event.data.recovery !== undefined ||
    (!options.force &&
      JSON.stringify(projection.text).length <= TOOL_RESULT_ARCHIVE_THRESHOLD_CHARS) ||
    projection.strategy === "durable-tool-result-archive-v1"
  )
    return event;
  let ref: string;
  try {
    ref = buildToolResultArchiveRef({
      sessionId: event.sessionId,
      eventId: event.eventId,
      sha256: body.sha256,
      sizeBytes: body.sizeBytes,
    });
  } catch {
    return event;
  }
  // Bound the resource address as well as the content; unusual identifiers fail open.
  if (ref.length > 1500) return event;
  return {
    ...event,
    data: {
      ...event.data,
      projection: {
        version: 1,
        mode: "preview",
        strategy: "durable-tool-result-archive-v1",
        truncated: true,
        text: `${options.supersededByToolCallId ? `[由 ${options.supersededByToolCallId} 替代：${options.reason}]\n` : ""}[工具结果已归档：${event.data.toolName.slice(0, 160)}，${body.content.length} 字符]\n${projection.text.slice(0, 500)}\n完整结果仍可读取：archive_read ${JSON.stringify({ ref, operation: "inspect" })}；支持 read（char/line）、search、query，offset 从 0 开始。也可用 read_file ${JSON.stringify({ path: ref, offset: 1, limit: 6000 })} 按字符分页（此分页接口从 1 开始）。`,
      },
    },
  };
}

export interface BoundToolResultArchiveReader {
  readRaw(path: string): Promise<string>;
  read(path: string, offset: number, limit: number): Promise<string>;
}
export function bindToolResultArchiveReader(
  store: SqliteRuntimeEventStore,
  sessionId: string,
): BoundToolResultArchiveReader {
  const readRaw = async (path: string): Promise<string> => {
    const identity = parseToolResultArchiveRef(path);
    if (!identity || path.length > 1500 || identity.sessionId !== sessionId)
      throw new Error("归档不可用：URI 无效或不属于当前会话");
    const row = (await store.readEventRowsByEventIds([identity.eventId])).get(identity.eventId);
    if (!row || row.sessionId !== sessionId) throw new Error("归档不可用：当前会话不存在该结果");
    const event = JSON.parse(row.payloadJson) as RuntimeToolResultRecordedEvent;
    if (
      event.kind !== "tool.result.recorded" ||
      event.sessionId !== sessionId ||
      event.eventId !== identity.eventId ||
      event.data.body.storage !== "inline"
    )
      throw new Error("归档不可用：源结果不匹配");
    const body = event.data.body;
    if (
      body.sha256 !== identity.sha256 ||
      body.sizeBytes !== identity.sizeBytes ||
      Buffer.byteLength(body.content, "utf8") !== identity.sizeBytes ||
      createHash("sha256").update(body.content).digest("hex") !== identity.sha256
    )
      throw new Error("归档不可用：完整性校验失败");
    return body.content;
  };
  return {
    readRaw,
    async read(path, offset, limit) {
      if (
        !Number.isSafeInteger(offset) ||
        offset < 1 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > TOOL_RESULT_ARCHIVE_MAX_LIMIT
      )
        throw new Error(`归档分页要求 offset >= 1，1 <= limit <= ${TOOL_RESULT_ARCHIVE_MAX_LIMIT}`);
      const body = { content: await readRaw(path) };
      if (offset > body.content.length + 1) throw new Error("归档 offset 超出结果范围");
      const start = offset - 1;
      const render = (end: number) =>
        JSON.stringify({
          kind: "tool_result_archive",
          path,
          offset,
          totalChars: body.content.length,
          content: body.content.slice(start, end),
          nextOffset: end < body.content.length ? end + 1 : null,
        });
      let low = start;
      let high = Math.min(start + limit, body.content.length);
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (render(mid).length <= TOOL_RESULT_ARCHIVE_MAX_RESPONSE_CHARS) low = mid;
        else high = mid - 1;
      }
      if (low === start && start < body.content.length)
        throw new Error("归档 URI 过长，无法生成有界页");
      return render(low);
    },
  };
}

/** Re-address an already archived immutable fact when a fork copies it. */
export function rebindToolResultArchive(
  event: RuntimeToolResultRecordedEvent,
): RuntimeToolResultRecordedEvent {
  if (
    event.data.body.storage !== "inline" ||
    event.data.projection.strategy !== "durable-tool-result-archive-v1"
  )
    return event;
  const ref = buildToolResultArchiveRef({
    sessionId: event.sessionId,
    eventId: event.eventId,
    sha256: event.data.body.sha256,
    sizeBytes: event.data.body.sizeBytes,
  });
  return {
    ...event,
    data: {
      ...event.data,
      projection: {
        ...event.data.projection,
        text: event.data.projection.text.replace(/pico:\/\/archive\/[^"\s]+/gu, ref),
      },
    },
  };
}
