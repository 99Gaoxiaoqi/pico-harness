interface UndoPayload {
  readonly factId: string;
  readonly version: number;
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
