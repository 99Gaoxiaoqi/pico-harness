import type { AssistantModelMessage, ModelMessage, ToolResultPart } from "ai";
import type { ImagePart, Message } from "../schema/message.js";

export type AiSdkWire = "openai" | "claude" | "responses";
type AssistantParts = Exclude<AssistantModelMessage["content"], string>;
type ProviderOptions = NonNullable<ModelMessage["providerOptions"]>;

interface SavedContent {
  wire: AiSdkWire;
  content: AssistantParts;
  toolResults: ToolResultPart[];
  projection: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function projection(message: Message): string {
  return JSON.stringify([
    message.content,
    message.reasoning ?? "",
    message.toolCalls ?? [],
    message.images ?? [],
  ]);
}

function parseInput(argumentsText: string): unknown {
  try {
    return JSON.parse(argumentsText);
  } catch {
    // Invalid model arguments must remain visible to Pico's tool validation.
    return argumentsText;
  }
}

function savedContent(message: Message, wire: AiSdkWire): SavedContent | undefined {
  const saved = record(message.providerData?.picoAiSdk);
  if (
    saved?.wire === wire &&
    saved.projection === projection(message) &&
    Array.isArray(saved.content) &&
    Array.isArray(saved.toolResults)
  ) {
    return saved as unknown as SavedContent;
  }
  return undefined;
}

/** Preserve the transcript order; Pico's user/toolCallId observations become SDK tool messages. */
export function toAiSdkMessages(
  messages: readonly Message[],
  wire: AiSdkWire,
  options?: { responsesWebSearchAnchors?: boolean },
): ModelMessage[] {
  const result: ModelMessage[] = [];
  const searchAnchors = wire === "responses" && options?.responsesWebSearchAnchors === true;
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "system") {
      result.push({ role: "system", content: message.content });
    } else if (message.role === "user" && message.toolCallId !== undefined) {
      const toolName = toolNames.get(message.toolCallId);
      if (toolName === undefined) {
        throw new Error(`Tool result has no preceding call: ${message.toolCallId}`);
      }
      result.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.toolCallId,
            toolName,
            output: { type: "text", value: message.content },
          },
        ],
      });
      toolNames.delete(message.toolCallId);
    } else if (message.role === "user") {
      result.push({
        role: "user",
        content: message.images?.length
          ? [
              ...message.images.map((image) => ({
                type: "file" as const,
                data: image.type === "image_base64" ? image.data : new URL(image.url),
                mediaType: image.type === "image_base64" ? image.mimeType : "image",
              })),
              { type: "text", text: message.content },
            ]
          : message.content,
      });
    } else {
      const saved = savedContent(message, wire);
      const content: AssistantParts = saved ? structuredClone(saved.content) : [];
      if (!saved) {
        // Claude accepts only authentic signed/redacted thinking. Never manufacture a signature.
        if (message.reasoning && wire !== "claude") {
          content.push({ type: "reasoning", text: message.reasoning });
        }
        if (message.content) content.push({ type: "text", text: message.content });
        for (const call of message.toolCalls ?? []) {
          content.push({
            type: "tool-call",
            toolCallId: call.id,
            toolName: call.name,
            input: parseInput(call.arguments),
          });
        }
        for (const image of message.images ?? []) {
          content.push({
            type: "file",
            mediaType: image.type === "image_base64" ? image.mimeType : "image",
            data: image.type === "image_base64" ? image.data : new URL(image.url),
          });
        }
      }
      for (let index = 0; index < content.length; index++) {
        const part = content[index]!;
        if (part.type === "tool-call") {
          toolNames.set(part.toolCallId, part.toolName);
          // SDK skips hosted search with store:false. This text item carries only an
          // ordering anchor; restoreResponsesWebSearch restores the raw item before dispatch.
          if (searchAnchors && record(part.providerOptions?.openai?.picoWebSearchItem)) {
            content[index] = {
              type: "text",
              text: "[provider search]",
              providerOptions: {
                openai: { itemId: part.toolCallId },
              },
            };
          }
        }
      }
      const rawSearchIds = new Set(
        (saved?.content ?? [])
          .filter(
            (part) =>
              part.type === "tool-call" && record(part.providerOptions?.openai?.picoWebSearchItem),
          )
          .map((part) => (part.type === "tool-call" ? part.toolCallId : "")),
      );
      result.push({
        role: "assistant",
        content: searchAnchors
          ? content.filter(
              (part) => part.type !== "tool-result" || !rawSearchIds.has(part.toolCallId),
            )
          : content,
      });
      if (saved?.toolResults.length) {
        result.push({ role: "tool", content: structuredClone(saved.toolResults) });
        for (const part of saved.toolResults) toolNames.delete(part.toolCallId);
      }
    }
  }
  return result;
}

/** Convert final generateText/streamText content, retaining replay metadata only, never request data. */
export function fromAiSdkContent(
  content: readonly unknown[],
  wire: AiSdkWire,
  responseOutput: readonly unknown[] = [],
): Message {
  const message: Message = { role: "assistant", content: "" };
  const parts: AssistantParts = [];
  const toolResults: ToolResultPart[] = [];
  const calls: Record<string, unknown>[] = [];
  const sources = new Map<string, Record<string, unknown>>();
  const addSource = (value: unknown) => {
    const source = record(value);
    if (typeof source?.url !== "string") return;
    sources.set(source.url, { ...sources.get(source.url), ...source });
  };
  for (const value of content) {
    const part = record(value);
    if (!part) continue;
    const metadata = record(part.providerMetadata);
    const options = metadata
      ? { providerOptions: JSON.parse(JSON.stringify(metadata)) as ProviderOptions }
      : {};
    switch (part.type) {
      case "text":
      case "reasoning": {
        if (typeof part.text !== "string") break;
        if (part.type === "text") message.content += part.text;
        else message.reasoning = (message.reasoning ?? "") + part.text;
        parts.push({ type: part.type, text: part.text, ...options });
        break;
      }
      case "tool-call": {
        if (typeof part.toolCallId !== "string" || typeof part.toolName !== "string") break;
        if (part.providerExecuted !== true) {
          (message.toolCalls ??= []).push({
            id: part.toolCallId,
            name: part.toolName,
            arguments:
              part.invalid === true && typeof part.input === "string"
                ? part.input
                : JSON.stringify(part.input ?? {}),
          });
        }
        if (part.providerExecuted === true && part.toolName === "web_search") {
          calls.push({
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input ?? {},
            status: "pending",
          });
        }
        const rawSearch = responseOutput
          .map(record)
          .find((item) => item?.type === "web_search_call" && item.id === part.toolCallId);
        parts.push({
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input ?? {},
          ...(typeof part.providerExecuted === "boolean"
            ? { providerExecuted: part.providerExecuted }
            : {}),
          ...options,
          ...(rawSearch
            ? {
                providerOptions: {
                  ...options.providerOptions,
                  openai: {
                    ...options.providerOptions?.openai,
                    picoWebSearchItem: JSON.parse(JSON.stringify(rawSearch)),
                  },
                },
              }
            : {}),
        });
        break;
      }
      case "tool-result":
      case "tool-error": {
        // Core SDK synthesizes errors for invalid/unknown calls even without execute.
        // Pico must receive and validate those calls itself.
        if (part.type === "tool-error" && part.providerExecuted !== true) break;
        if (typeof part.toolCallId !== "string" || typeof part.toolName !== "string") break;
        const output = part.type === "tool-error" ? part.error : part.output;
        const result: ToolResultPart = {
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output:
            part.type === "tool-error"
              ? record(output) && !(output instanceof Error)
                ? { type: "error-json", value: JSON.parse(JSON.stringify(output)) }
                : {
                    type: "error-text",
                    value: output instanceof Error ? output.message : String(output),
                  }
              : typeof output === "string"
                ? { type: "text", value: output }
                : { type: "json", value: JSON.parse(JSON.stringify(output ?? null)) },
          ...options,
        };
        const searchCall = calls.find((call) => call.toolCallId === part.toolCallId);
        if (searchCall) {
          searchCall.status = part.type === "tool-error" ? "error" : "completed";
          searchCall[part.type === "tool-error" ? "error" : "output"] =
            output instanceof Error ? output.message : output;
          const found = Array.isArray(output) ? output : record(output)?.sources;
          if (Array.isArray(found))
            for (const source of found) {
              const item = record(source);
              if (item)
                addSource({
                  url: item.url,
                  ...(typeof item.title === "string" ? { title: item.title } : {}),
                });
            }
        }
        if (part.providerExecuted === true) parts.push(result);
        else toolResults.push(result);
        // A result already supplied by the SDK must not execute again in Pico.
        message.toolCalls = message.toolCalls?.filter((call) => call.id !== part.toolCallId);
        break;
      }
      case "file":
      case "reasoning-file": {
        const file = record(part.file);
        if (!file || typeof file.base64 !== "string" || typeof file.mediaType !== "string") break;
        parts.push({ type: part.type, data: file.base64, mediaType: file.mediaType, ...options });
        if (part.type === "file" && file.mediaType.startsWith("image/")) {
          (message.images ??= []).push({
            type: "image_base64",
            mimeType: file.mediaType,
            data: file.base64,
          } satisfies ImagePart);
        }
        break;
      }
      case "source":
        if (part.sourceType === "url") addSource(JSON.parse(JSON.stringify(part)));
        break;
      case "custom":
        if (typeof part.kind === "string" && part.kind.includes(".")) {
          parts.push({ type: "custom", kind: part.kind as `${string}.${string}`, ...options });
        }
        break;
    }
  }
  // The SDK emits a result even for an unsuccessful Responses search item.
  // Completion is proven by the native item status, not by HTTP 200 or a result wrapper.
  for (const value of responseOutput) {
    const item = record(value);
    if (item?.type !== "web_search_call" || item.status === "completed") continue;
    const call = calls.find((candidate) => candidate.toolCallId === item.id);
    if (call) {
      call.status = item.status === "failed" ? "error" : "pending";
      if (item.status === "failed") call.error = "provider-search-failed";
    }
  }
  if (message.toolCalls?.length === 0) delete message.toolCalls;
  message.providerData = {
    ...(calls.length || sources.size
      ? { picoWebSearch: { calls, sources: [...sources.values()] } }
      : {}),
    picoAiSdk: {
      wire,
      content: parts,
      toolResults,
      projection: projection(message),
    } satisfies SavedContent,
  };
  return message;
}

/** Restore saved items only while their message projection is unchanged, preserving input order. */
export function restoreResponsesWebSearch(
  body: Record<string, unknown>,
  messages: readonly Message[],
): Record<string, unknown> {
  if (!Array.isArray(body.input)) return body;
  const items = new Map<string, Record<string, unknown>>();
  for (const message of messages) {
    for (const part of savedContent(message, "responses")?.content ?? []) {
      if (
        part.type !== "tool-call" ||
        part.providerExecuted !== true ||
        part.toolName !== "web_search"
      )
        continue;
      const item = record(part.providerOptions?.openai?.picoWebSearchItem);
      if (item?.type === "web_search_call" && item.id === part.toolCallId)
        items.set(part.toolCallId, item);
    }
  }
  return {
    ...body,
    input: body.input.map((value: unknown) => {
      const part = record(value);
      return part?.role === "assistant" && typeof part.id === "string" && items.has(part.id)
        ? structuredClone(items.get(part.id)!)
        : value;
    }),
  };
}
