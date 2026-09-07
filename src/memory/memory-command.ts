import type { SlashCommand } from "../input/types.js";
import { DesktopAtomicMemoryService } from "../daemon/desktop-atomic-memory-service.js";
import { resolvePicoPaths } from "../paths/pico-paths.js";
import { WorkspaceTrustStore } from "../security/workspace-trust.js";

export interface MemoryCommandOptions {
  readonly workDir: string;
  readonly picoHome?: string;
  readonly trustStore?: WorkspaceTrustStore;
}
interface UndoPayload {
  readonly factId: string;
  readonly version: number;
}

/** The in-process command shares the atomic management boundary with Desktop. */
export function createMemoryCommand(options: MemoryCommandOptions): SlashCommand {
  return {
    name: "memory",
    description: "Remember an atomic memory or control workspace recall",
    usage: "/memory remember <text>|status|off|on",
    argumentHint: "remember <text>|status|off|on",
    category: "workspace",
    kind: "local",
    availability: "idle",
    execute: async (input) => {
      try {
        const trust =
          options.trustStore ?? new WorkspaceTrustStore({ userStateDirectory: options.picoHome });
        const workspacePath = await trust.canonicalize(options.workDir);
        if (!(await trust.isTrusted(workspacePath)))
          throw new Error(`workspace is not trusted: ${workspacePath}`);
        const paths = resolvePicoPaths(workspacePath, { picoHome: options.picoHome });
        const service = new DesktopAtomicMemoryService({
          picoHome: paths.home.root,
          publish: () => {},
        });
        try {
          const [operation, ...rest] = input.argv;
          switch (operation?.toLowerCase()) {
            case "remember": {
              const content = rest.join(" ").trim();
              if (!content) return message("Usage: /memory remember <text>");
              const { fact } = await service.create(workspacePath, content);
              return message(
                `Remembered workspace fact ${fact.factId}. Undo: /memory undo ${encodeUndo({ factId: fact.factId, version: fact.version })}`,
              );
            }
            case "status": {
              const [{ settings }, { facts }] = await Promise.all([
                service.getSettings(workspacePath),
                service.list(workspacePath, { workspacePath, limit: 1000 }),
              ]);
              return message(
                [
                  `Memory: ${settings.enabled ? "on" : "off"}`,
                  `Injection: ${settings.injectionEnabled ? "on" : "off"}`,
                  `Automatic extraction: ${settings.autoPropose ? "on" : "off"}`,
                  "Validated memories are saved directly.",
                  `Active facts: ${facts.filter((fact) => fact.state === "active").length}`,
                  `Archived facts: ${facts.filter((fact) => fact.state === "archived").length}`,
                ].join("\n"),
              );
            }
            case "off":
            case "on": {
              const enabled = operation.toLowerCase() === "on";
              const { settings } = await service.getSettings(workspacePath);
              if (settings.enabled === enabled && settings.injectionEnabled === enabled)
                return message(`Memory is already ${enabled ? "on" : "off"}.`);
              await service.updateSettings(workspacePath, {
                workspacePath,
                expectedVersion: settings.version,
                idempotencyKey: `memory-toggle:${enabled}:${settings.version}`,
                enabled,
                injectionEnabled: enabled,
              });
              return message(
                enabled
                  ? "Memory enabled; controlled recall is active."
                  : "Memory disabled; recall injection and automatic extraction are off.",
              );
            }
            case "undo": {
              if (!rest[0]) return message("Usage: /memory undo <token>");
              const payload = decodeUndo(rest[0]);
              const { fact } = await service.get(workspacePath, payload.factId);
              if (fact.version !== payload.version || fact.state !== "active")
                return message(
                  "Undo unavailable: the fact changed after this undo token was issued.",
                );
              const { fact: archived } = await service.update(workspacePath, {
                workspacePath,
                factId: fact.factId,
                expectedVersion: payload.version,
                state: "archived",
                idempotencyKey: `memory-undo:${fact.factId}:${payload.version}`,
              });
              return message(`Undone: workspace fact ${archived.factId} is archived.`);
            }
            default:
              return message("Usage: /memory remember <text>|status|off|on");
          }
        } finally {
          service.close();
        }
      } catch (error) {
        return message(
          `Memory unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

function encodeUndo(payload: UndoPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
}

/** TUI 客户端 /memory undo 共享编解码（token 只含 factId + version，无秘密）。 */
export const encodeMemoryUndoToken = encodeUndo;
export const decodeMemoryUndoToken = decodeUndo;

function decodeUndo(value: string): UndoPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error("invalid memory undo token");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof Reflect.get(parsed, "factId") !== "string" ||
    !Number.isSafeInteger(Reflect.get(parsed, "version")) ||
    Number(Reflect.get(parsed, "version")) <= 0
  ) {
    throw new Error("invalid memory undo token");
  }
  return {
    factId: String(Reflect.get(parsed, "factId")),
    version: Number(Reflect.get(parsed, "version")),
  };
}

function message(text: string) {
  return { type: "local" as const, action: "message" as const, message: text };
}
