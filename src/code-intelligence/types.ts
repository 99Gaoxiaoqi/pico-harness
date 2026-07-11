export interface CodePosition {
  /** 面向用户与工具的 1-based 行号。 */
  readonly line: number;
  /** 面向用户与工具的 1-based UTF-16 字符列。 */
  readonly character: number;
}

export interface CodeRange {
  readonly start: CodePosition;
  readonly end: CodePosition;
}

export interface CodeLocation {
  readonly filePath: string;
  readonly range: CodeRange;
}

export interface PositionQuery {
  readonly filePath: string;
  readonly position: CodePosition;
}

export interface SymbolQuery {
  readonly query?: string;
  readonly filePath?: string;
  readonly limit?: number;
}

export interface CodeSymbol {
  readonly name: string;
  readonly kind: string;
  readonly location: CodeLocation;
  readonly containerName?: string;
}

export type DiagnosticSeverity = "error" | "warning" | "information" | "hint";

export interface CodeDiagnostic {
  readonly message: string;
  readonly severity: DiagnosticSeverity;
  readonly location: CodeLocation;
  readonly source?: string;
  readonly code?: string;
}

export interface CodeCall {
  readonly caller: CodeSymbol;
  readonly callee: CodeSymbol;
  readonly ranges: readonly CodeRange[];
}

export interface CodeIntelligenceQueryOptions {
  readonly signal?: AbortSignal;
}

/** LSP 与 Repo Map 共用的统一代码查询边界。 */
export interface CodeIntelligenceService {
  readonly backend: "lsp" | "repo-map";
  definitions(
    query: PositionQuery,
    options?: CodeIntelligenceQueryOptions,
  ): Promise<readonly CodeLocation[]>;
  references(
    query: PositionQuery,
    options?: CodeIntelligenceQueryOptions,
  ): Promise<readonly CodeLocation[]>;
  symbols(
    query: SymbolQuery,
    options?: CodeIntelligenceQueryOptions,
  ): Promise<readonly CodeSymbol[]>;
  diagnostics(
    filePath: string,
    options?: CodeIntelligenceQueryOptions,
  ): Promise<readonly CodeDiagnostic[]>;
  callHierarchy(
    query: PositionQuery,
    direction: "incoming" | "outgoing",
    options?: CodeIntelligenceQueryOptions,
  ): Promise<readonly CodeCall[]>;
  close(): Promise<void>;
}
