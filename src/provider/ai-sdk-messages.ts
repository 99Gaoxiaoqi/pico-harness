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
export function toAiSdkMessages(messages: readonly Message[], wire: AiSdkWire): ModelMessage[] {
  const result: ModelMessage[] = [];
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
      for (const part of content) {
        if (part.type === "tool-call") toolNames.set(part.toolCallId, part.toolName);
      }
      result.push({ role: "assistant", content });
      if (saved?.toolResults.length) {
        result.push({ role: "tool", content: structuredClone(saved.toolResults) });
        for (const part of saved.toolResults) toolNames.delete(part.toolCallId);
      }
    }
  }
  return result;
}

/** Convert final generateText/streamText content, retaining replay metadata only, never request data. */
export function fromAiSdkContent(content: readonly unknown[], wire: AiSdkWire): Message {
  const message: Message = { role: "assistant", content: "" };
  const parts: AssistantParts = [];
  const toolResults: ToolResultPart[] = [];
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
        parts.push({
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input ?? {},
          ...(typeof part.providerExecuted === "boolean"
            ? { providerExecuted: part.providerExecuted }
            : {}),
          ...options,
        });
        break;
      }
      case "tool-result":
      case "tool-error": {
        if (typeof part.toolCallId !== "string" || typeof part.toolName !== "string") break;
        const output = part.type === "tool-error" ? part.error : part.output;
        const result: ToolResultPart = {
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output:
            part.type === "tool-error"
              ? {
                  type: "error-text",
                  value: output instanceof Error ? output.message : String(output),
                }
              : typeof output === "string"
                ? { type: "text", value: output }
                : { type: "json", value: JSON.parse(JSON.stringify(output ?? null)) },
          ...options,
        };
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
      case "custom":
        if (typeof part.kind === "string" && part.kind.includes(".")) {
          parts.push({ type: "custom", kind: part.kind as `${string}.${string}`, ...options });
        }
        break;
    }
  }
  if (message.toolCalls?.length === 0) delete message.toolCalls;
  message.providerData = {
    picoAiSdk: {
      wire,
      content: parts,
      toolResults,
      projection: projection(message),
    } satisfies SavedContent,
  };
  return message;
}
