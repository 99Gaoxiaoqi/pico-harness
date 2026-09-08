import {
  type LocalCommandResult,
  type SlashArgumentCandidate,
  type SlashArgumentCompleter,
  type SlashCommand,
} from "../../input/types.js";
import { type ClientSessionRuntime } from "../client-session-runtime.js";

const ARGUMENT_COMPLETER_CACHE_TTL_MS = 5_000;

export function rpcCommand(spec: SlashCommand): SlashCommand {
  return { ...spec, kind: spec.kind ?? "local" };
}

export function staticCompleter(values: readonly string[]) {
  return (query: string): readonly { value: string }[] =>
    values.filter((value) => value.startsWith(query.toLowerCase())).map((value) => ({ value }));
}

export function cachedArgumentCompleter<T>(
  load: () => Promise<T>,
  project: (loaded: T) => readonly SlashArgumentCandidate[],
): SlashArgumentCompleter {
  let cache: { at: number; candidates: readonly SlashArgumentCandidate[] } | undefined;
  return async (query) => {
    if (cache === undefined || Date.now() - cache.at > ARGUMENT_COMPLETER_CACHE_TTL_MS) {
      try {
        cache = { at: Date.now(), candidates: project(await load()) };
      } catch {
        return [];
      }
    }
    const lowered = query.toLowerCase();
    if (!lowered) return cache.candidates;
    return cache.candidates.filter((candidate) =>
      `${candidate.value} ${candidate.label ?? ""} ${candidate.description ?? ""}`
        .toLowerCase()
        .includes(lowered),
    );
  };
}

export function sessionAccess(runtime: ClientSessionRuntime) {
  const session = (): string | undefined => runtime.activeSessionId;
  const needSession = (): string | LocalCommandResult => {
    const id = session();
    return id === undefined
      ? {
          type: "local",
          action: "message",
          message: "当前没有活跃会话；先发送一条消息或 /resume。",
        }
      : id;
  };
  return { session, needSession };
}
