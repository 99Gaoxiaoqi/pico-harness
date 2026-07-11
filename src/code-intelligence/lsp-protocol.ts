export type JsonRpcId = number | string;

export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

export interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

export interface LspLocation {
  readonly uri: string;
  readonly range: LspRange;
}

export interface LspJsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface LspJsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export interface LspJsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export type LspServerMessage = LspJsonRpcRequest | LspJsonRpcNotification | LspJsonRpcResponse;

export function isJsonRpcResponse(message: LspServerMessage): message is LspJsonRpcResponse {
  return "id" in message && !("method" in message);
}

export function isJsonRpcNotification(
  message: LspServerMessage,
): message is LspJsonRpcNotification {
  return "method" in message && !("id" in message);
}
