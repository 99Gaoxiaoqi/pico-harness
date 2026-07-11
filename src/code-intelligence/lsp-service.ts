import { constants as fsConstants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { StdioLspClient } from "./lsp-client.js";
import type { LspPosition } from "./lsp-protocol.js";
import type {
  CodeCall,
  CodeDiagnostic,
  CodeIntelligenceQueryOptions,
  CodeIntelligenceService,
  CodeLocation,
  CodeRange,
  CodeSymbol,
  DiagnosticSeverity,
  PositionQuery,
  SymbolQuery,
} from "./types.js";

type UnknownRecord = Record<string, unknown>;

const SYMBOL_KINDS: Readonly<Record<number, string>> = {
  1: "file",
  2: "module",
  3: "namespace",
  4: "package",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  15: "string",
  16: "number",
  17: "boolean",
  18: "array",
  19: "object",
  20: "key",
  21: "null",
  22: "enum-member",
  23: "struct",
  24: "event",
  25: "operator",
  26: "type-parameter",
};

const DIAGNOSTIC_SEVERITIES: Readonly<Record<number, DiagnosticSeverity>> = {
  1: "error",
  2: "warning",
  3: "information",
  4: "hint",
};

const MAX_LSP_DOCUMENT_BYTES = 4 * 1024 * 1024;

export class LspCodeIntelligenceService implements CodeIntelligenceService {
  readonly backend = "lsp" as const;
  private readonly openedDocuments = new Map<string, { text: string; version: number }>();
  private readonly diagnosticsByUri = new Map<string, readonly CodeDiagnostic[]>();
  private readonly unsubscribeDiagnostics: () => void;

  constructor(
    private readonly rootDir: string,
    private readonly client: StdioLspClient,
  ) {
    this.unsubscribeDiagnostics = client.onNotification(
      "textDocument/publishDiagnostics",
      (params) => this.rememberDiagnostics(params),
    );
  }

  async definitions(
    query: PositionQuery,
    options: CodeIntelligenceQueryOptions = {},
  ): Promise<readonly CodeLocation[]> {
    const uri = await this.ensureOpen(query.filePath);
    const result = await this.client.request(
      "textDocument/definition",
      { textDocument: { uri }, position: toLspPosition(query.position) },
      signalOptions(options),
    );
    return normalizeLocations(result);
  }

  async references(
    query: PositionQuery,
    options: CodeIntelligenceQueryOptions = {},
  ): Promise<readonly CodeLocation[]> {
    const uri = await this.ensureOpen(query.filePath);
    const result = await this.client.request(
      "textDocument/references",
      {
        textDocument: { uri },
        position: toLspPosition(query.position),
        context: { includeDeclaration: true },
      },
      signalOptions(options),
    );
    return normalizeLocations(result);
  }

  async symbols(
    query: SymbolQuery,
    options: CodeIntelligenceQueryOptions = {},
  ): Promise<readonly CodeSymbol[]> {
    const limit = Math.max(1, query.limit ?? 100);
    if (query.filePath) {
      const uri = await this.ensureOpen(query.filePath);
      const result = await this.client.request(
        "textDocument/documentSymbol",
        { textDocument: { uri } },
        signalOptions(options),
      );
      return normalizeDocumentSymbols(result, uri, query.query).slice(0, limit);
    }
    const result = await this.client.request(
      "workspace/symbol",
      { query: query.query ?? "" },
      signalOptions(options),
    );
    return normalizeWorkspaceSymbols(result).slice(0, limit);
  }

  async diagnostics(
    filePath: string,
    options: CodeIntelligenceQueryOptions = {},
  ): Promise<readonly CodeDiagnostic[]> {
    const uri = await this.ensureOpen(filePath);
    try {
      const result = await this.client.request(
        "textDocument/diagnostic",
        { textDocument: { uri } },
        signalOptions(options),
      );
      if (isRecord(result) && Array.isArray(result.items)) {
        const items = result.items;
        const diagnostics = normalizeDiagnostics(uri, items);
        this.diagnosticsByUri.set(uri, diagnostics);
        return diagnostics;
      }
    } catch (error) {
      if (options.signal?.aborted) throw error;
      // 大多数 server 仅通过 publishDiagnostics 推送；拉取不支持时返回快照。
    }
    return this.diagnosticsByUri.get(uri) ?? [];
  }

  async callHierarchy(
    query: PositionQuery,
    direction: "incoming" | "outgoing",
    options: CodeIntelligenceQueryOptions = {},
  ): Promise<readonly CodeCall[]> {
    const uri = await this.ensureOpen(query.filePath);
    const prepared = await this.client.request(
      "textDocument/prepareCallHierarchy",
      { textDocument: { uri }, position: toLspPosition(query.position) },
      signalOptions(options),
    );
    const item = Array.isArray(prepared) ? prepared.find(isRecord) : undefined;
    if (!item) return [];
    const result = await this.client.request(
      `callHierarchy/${direction === "incoming" ? "incomingCalls" : "outgoingCalls"}`,
      { item },
      signalOptions(options),
    );
    return normalizeCalls(result, item, direction);
  }

  async close(): Promise<void> {
    this.unsubscribeDiagnostics();
    await this.client.close();
  }

  private async ensureOpen(filePath: string): Promise<string> {
    const rootPath = await realpath(this.rootDir);
    const requestedPath = path.resolve(rootPath, filePath);
    let physicalPath: string;
    try {
      physicalPath = await realpath(requestedPath);
    } catch (error) {
      throw new Error(`代码智能无法解析文件 ${filePath}: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    const relativePath = path.relative(rootPath, physicalPath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`代码智能查询越出工作区: ${filePath}`);
    }
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await open(physicalPath, flags);
    let text: string;
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error(`代码智能只能打开普通文件: ${filePath}`);
      if (info.size > MAX_LSP_DOCUMENT_BYTES) {
        throw new Error(`代码智能文件超过 ${MAX_LSP_DOCUMENT_BYTES} 字节上限: ${filePath}`);
      }
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    const uri = pathToFileURL(physicalPath).href;
    const opened = this.openedDocuments.get(uri);
    if (opened) {
      if (opened.text !== text) {
        const version = opened.version + 1;
        this.client.notify("textDocument/didChange", {
          textDocument: { uri, version },
          contentChanges: [{ text }],
        });
        this.openedDocuments.set(uri, { text, version });
      }
      return uri;
    }
    this.client.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: languageIdForPath(physicalPath),
        version: 1,
        text,
      },
    });
    this.openedDocuments.set(uri, { text, version: 1 });
    return uri;
  }

  private rememberDiagnostics(params: unknown): void {
    if (!isRecord(params) || typeof params.uri !== "string" || !Array.isArray(params.diagnostics)) {
      return;
    }
    this.diagnosticsByUri.set(params.uri, normalizeDiagnostics(params.uri, params.diagnostics));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function signalOptions(options: CodeIntelligenceQueryOptions): { signal?: AbortSignal } {
  return options.signal ? { signal: options.signal } : {};
}

function toLspPosition(position: {
  readonly line: number;
  readonly character: number;
}): LspPosition {
  return {
    line: Math.max(0, position.line - 1),
    character: Math.max(0, position.character - 1),
  };
}

function normalizeLocations(value: unknown): CodeLocation[] {
  const candidates = Array.isArray(value) ? value : value === null ? [] : [value];
  return candidates.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const uri = stringProperty(candidate, "uri") ?? stringProperty(candidate, "targetUri");
    const rangeValue = candidate.range ?? candidate.targetSelectionRange ?? candidate.targetRange;
    const range = normalizeRange(rangeValue);
    if (!uri || !range) return [];
    return [{ filePath: uriToPath(uri), range }];
  });
}

function normalizeWorkspaceSymbols(value: unknown): CodeSymbol[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.name !== "string") return [];
    const location = normalizeLocation(candidate.location);
    if (!location) return [];
    return [
      {
        name: candidate.name,
        kind: symbolKind(candidate.kind),
        location,
        ...(typeof candidate.containerName === "string"
          ? { containerName: candidate.containerName }
          : {}),
      },
    ];
  });
}

function normalizeDocumentSymbols(value: unknown, uri: string, query?: string): CodeSymbol[] {
  if (!Array.isArray(value)) return [];
  const needle = query?.trim().toLowerCase();
  const output: CodeSymbol[] = [];
  const visit = (candidate: unknown, inheritedContainer?: string): void => {
    if (!isRecord(candidate) || typeof candidate.name !== "string") return;
    const location =
      normalizeLocation(candidate.location) ?? locationFromRange(uri, candidate.range);
    if (location && (!needle || candidate.name.toLowerCase().includes(needle))) {
      output.push({
        name: candidate.name,
        kind: symbolKind(candidate.kind),
        location,
        ...(typeof candidate.containerName === "string"
          ? { containerName: candidate.containerName }
          : inheritedContainer
            ? { containerName: inheritedContainer }
            : {}),
      });
    }
    if (Array.isArray(candidate.children)) {
      for (const child of candidate.children) visit(child, candidate.name);
    }
  };
  for (const candidate of value) visit(candidate);
  return output;
}

function normalizeDiagnostics(uri: string, value: readonly unknown[]): CodeDiagnostic[] {
  return value.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.message !== "string") return [];
    const range = normalizeRange(candidate.range);
    if (!range) return [];
    return [
      {
        message: candidate.message,
        severity: diagnosticSeverity(candidate.severity),
        location: { filePath: uriToPath(uri), range },
        ...(typeof candidate.source === "string" ? { source: candidate.source } : {}),
        ...(typeof candidate.code === "string" || typeof candidate.code === "number"
          ? { code: String(candidate.code) }
          : {}),
      },
    ];
  });
}

function normalizeCalls(
  value: unknown,
  origin: UnknownRecord,
  direction: "incoming" | "outgoing",
): CodeCall[] {
  const originSymbol = normalizeHierarchyItem(origin);
  if (!originSymbol || !Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const peerValue = direction === "incoming" ? candidate.from : candidate.to;
    const peer = normalizeHierarchyItem(peerValue);
    const rawRanges = direction === "incoming" ? candidate.fromRanges : candidate.fromRanges;
    if (!peer) return [];
    const ranges = Array.isArray(rawRanges)
      ? rawRanges.flatMap((range) => normalizeRange(range) ?? [])
      : [];
    return [
      direction === "incoming"
        ? { caller: peer, callee: originSymbol, ranges }
        : { caller: originSymbol, callee: peer, ranges },
    ];
  });
}

function normalizeHierarchyItem(value: unknown): CodeSymbol | undefined {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.uri !== "string") {
    return undefined;
  }
  const range = normalizeRange(value.selectionRange ?? value.range);
  if (!range) return undefined;
  return {
    name: value.name,
    kind: symbolKind(value.kind),
    location: { filePath: uriToPath(value.uri), range },
    ...(typeof value.detail === "string" ? { containerName: value.detail } : {}),
  };
}

function normalizeLocation(value: unknown): CodeLocation | undefined {
  if (!isRecord(value) || typeof value.uri !== "string") return undefined;
  const range = normalizeRange(value.range);
  return range ? { filePath: uriToPath(value.uri), range } : undefined;
}

function locationFromRange(uri: string, value: unknown): CodeLocation | undefined {
  const range = normalizeRange(value);
  return range ? { filePath: uriToPath(uri), range } : undefined;
}

function normalizeRange(value: unknown): CodeRange | undefined {
  if (!isRecord(value)) return undefined;
  const start = normalizePosition(value.start);
  const end = normalizePosition(value.end);
  return start && end ? { start, end } : undefined;
}

function normalizePosition(value: unknown): { line: number; character: number } | undefined {
  if (!isRecord(value) || typeof value.line !== "number" || typeof value.character !== "number") {
    return undefined;
  }
  return { line: value.line + 1, character: value.character + 1 };
}

function symbolKind(value: unknown): string {
  return typeof value === "number" ? (SYMBOL_KINDS[value] ?? `kind-${value}`) : "unknown";
}

function diagnosticSeverity(value: unknown): DiagnosticSeverity {
  return typeof value === "number"
    ? (DIAGNOSTIC_SEVERITIES[value] ?? "information")
    : "information";
}

function languageIdForPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const languages: Readonly<Record<string, string>> = {
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
  };
  return languages[extension] ?? "plaintext";
}

function uriToPath(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
}

function stringProperty(value: UnknownRecord, key: string): string | undefined {
  const property = value[key];
  return typeof property === "string" ? property : undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
