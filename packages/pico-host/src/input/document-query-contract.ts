/** Shared worker contract. Offsets are zero-based; PDF pages and Excel addresses are one-based. */
export type DocumentKind = "text" | "pdf" | "word" | "spreadsheet";

export interface SpreadsheetFilter {
  readonly column: string;
  readonly operator: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains";
  readonly value: string | number | boolean;
}

export type DocumentQuery =
  | { readonly action: "inspect" }
  | {
      readonly action: "read";
      readonly page?: number;
      readonly sheet?: string;
      readonly range?: string;
      /** Character offset within the selected, location-labelled text. */
      readonly offset?: number;
      readonly limit?: number;
    }
  | {
      readonly action: "search";
      readonly query: string;
      readonly sheet?: string;
      /** Match offset, not character offset. Search is literal and case-insensitive. */
      readonly offset?: number;
      readonly limit?: number;
    }
  | { readonly action: "view"; readonly page: number }
  | {
      readonly action: "analyze";
      readonly sheet?: string;
      readonly range: string;
      readonly operation: "sum" | "average" | "min" | "max" | "count";
      /** Excel column letters, e.g. C. Required except for row count. */
      readonly column?: string;
      readonly groupBy?: string;
      readonly filters?: readonly SpreadsheetFilter[];
      /** Whether the first row of range is a header; default true. */
      readonly header?: boolean;
    };

export interface DocumentManifest {
  readonly kind: DocumentKind;
  readonly name: string;
  readonly pages?: number;
  readonly paragraphs?: number;
  readonly lines?: number;
  readonly sheets?: readonly { readonly name: string; readonly rows: number; readonly columns: number }[];
  readonly warnings: readonly string[];
}

export interface DocumentQueryResult {
  readonly kind: DocumentKind;
  /** Bounded, human/model-readable output, including source locations and coverage. */
  readonly text: string;
  readonly manifest?: DocumentManifest;
  readonly nextOffset?: number;
  readonly total?: number;
  readonly warnings?: readonly string[];
  readonly image?: {
    readonly mimeType: "image/png";
    readonly data: string;
    readonly width: number;
    readonly height: number;
  };
}

export const DOCUMENT_QUERY_MAX_CHARS = 16_000;
export const DOCUMENT_QUERY_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
