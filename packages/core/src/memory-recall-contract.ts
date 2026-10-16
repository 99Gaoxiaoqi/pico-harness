import type { MemoryItemSource } from "./atomic-memory-contracts.js";

/** No query, key or memory body is permitted in this durable diagnostic. */
export interface MemoryRecallTrace {
  readonly version: 1 | 2;
  readonly recordType?: "memory" | "case";
  readonly caseSelected?: readonly MemoryRecallCaseSelectedItem[];
  readonly queryPolicyVersion?: number;
  readonly limited?: boolean;
  readonly mode: "automatic" | "search";
  readonly workspaceKey: string;
  readonly settingsVersion?: number;
  readonly queryHash: string;
  readonly blockHash?: string;
  readonly queryRef?: {
    readonly eventId?: string;
    readonly toolCallId?: string;
    readonly anchorEventId?: string;
  };
  readonly outcome:
    | "selected"
    | "no_hits"
    | "budget_exhausted"
    | "disabled"
    | "admission_denied"
    | "error"
    | "limited";
  readonly stages: {
    readonly exact: number;
    readonly prefix: number;
    readonly content: number;
    readonly compound: number;
    readonly candidates: number;
  };
  readonly budget: {
    readonly maxItems: number;
    readonly maxTokens: number;
    readonly usedTokens: number;
    readonly usedItems: number;
    readonly maxItemTokens?: number;
    readonly truncated: boolean;
  };
  readonly counts: {
    readonly selected: number;
    readonly duplicate: number;
    readonly budget: number;
    readonly item_limit: number;
  };
  readonly selected: readonly MemoryRecallSelectedItem[];
  readonly diagnostics: readonly MemoryRecallDiagnostic[];
  readonly elapsedMs: number;
  readonly traceTruncated: boolean;
  readonly omittedDiagnosticCount: number;
  readonly omittedSourceCount: number;
}
export interface MemoryRecallSelectedItem {
  readonly itemId: string;
  readonly itemVersion: number;
  readonly contentHash: string;
  readonly referenceHash: string;
  readonly range: { readonly start: number; readonly end: number; readonly total: number };
  readonly excerpt: boolean;
  readonly match: "key" | "content" | "preference";
  readonly source:
    | "user-evidence"
    | "manual"
    | "assistant-note"
    | "execution-evidence"
    | "execution-validated"
    | "reviewed-reference";
  readonly sourceCount: number;
  readonly sources: readonly MemoryItemSource[];
  readonly rank?: number;
  readonly score?: number;
}
export interface MemoryRecallCaseSelectedItem {
  readonly candidateId: string;
  readonly contentVersion: number;
  readonly recordRevision: number;
  readonly referenceHash: string;
  readonly range: { readonly start: number; readonly end: number; readonly total: number };
  readonly excerpt: boolean;
  readonly sourceCount: number;
  readonly sources: readonly MemoryItemSource[];
}
export interface MemoryRecallDiagnostic {
  readonly itemId: string;
  readonly reason: "duplicate" | "budget" | "item_limit";
  readonly match: "key" | "content" | "preference";
  readonly rank?: number;
  readonly score?: number;
}
export interface MemoryRecallRequestFacts {
  readonly version: 1 | 2;
  readonly coverage: "recorded" | "unrecorded";
  readonly recalls: readonly {
    readonly recallEventId: string;
    readonly blockHash?: string;
    readonly references: readonly { readonly itemId: string; readonly referenceHash: string }[];
    readonly caseReferences?: readonly {
      readonly candidateId: string;
      readonly contentVersion: number;
      readonly recordRevision: number;
      readonly referenceHash: string;
    }[];
  }[];
}

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(v).every((k) => allowed.includes(k));
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 1024;
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const match = (v: unknown) => ["key", "content", "preference"].includes(v as string);
const rankScore = (v: Record<string, unknown>) =>
  (v["rank"] === undefined || integer(v["rank"])) &&
  (v["score"] === undefined || (typeof v["score"] === "number" && Number.isFinite(v["score"])));
export function isMemoryRecallTrace(v: unknown): v is MemoryRecallTrace {
  if (
    !record(v) ||
    !keys(v, [
      "version",
      "recordType",
      "caseSelected",
      "queryPolicyVersion",
      "limited",
      "mode",
      "workspaceKey",
      "settingsVersion",
      "queryHash",
      "blockHash",
      "queryRef",
      "outcome",
      "stages",
      "budget",
      "counts",
      "selected",
      "diagnostics",
      "elapsedMs",
      "traceTruncated",
      "omittedDiagnosticCount",
      "omittedSourceCount",
    ]) ||
    new TextEncoder().encode(JSON.stringify(v)).length > 8192
  )
    return false;
  const stages = v["stages"],
    budget = v["budget"],
    counts = v["counts"],
    ref = v["queryRef"];
  return (
    (v["version"] === 1
      ? v["recordType"] !== "case" && v["caseSelected"] === undefined && v["limited"] === undefined
      : v["version"] === 2 &&
        v["recordType"] === "case" &&
        v["mode"] === "search" &&
        Array.isArray(v["caseSelected"]) &&
        v["caseSelected"].length <= 3 &&
        v["caseSelected"].every(isMemoryRecallCaseSelectedItem) &&
        Array.isArray(v["selected"]) &&
        v["selected"].length === 0 &&
        Array.isArray(v["diagnostics"]) &&
        v["diagnostics"].length === 0 &&
        record(budget) &&
        budget["maxItems"] === 3 &&
        budget["maxTokens"] === 1500 &&
        (budget["usedTokens"] as number) <= 1500 &&
        budget["usedItems"] === v["caseSelected"].length &&
        (v["limited"] === undefined || typeof v["limited"] === "boolean")) &&
    (v["recordType"] === undefined || ["memory", "case"].includes(v["recordType"] as string)) &&
    (v["queryPolicyVersion"] === undefined || integer(v["queryPolicyVersion"])) &&
    ["automatic", "search"].includes(v["mode"] as string) &&
    text(v["workspaceKey"]) &&
    hash(v["queryHash"]) &&
    (v["blockHash"] === undefined || hash(v["blockHash"])) &&
    (v["settingsVersion"] === undefined || integer(v["settingsVersion"])) &&
    (ref === undefined ||
      (record(ref) &&
        keys(ref, ["eventId", "toolCallId", "anchorEventId"]) &&
        (ref["anchorEventId"] === undefined || text(ref["anchorEventId"])) &&
        (ref["eventId"] === undefined || text(ref["eventId"])) &&
        (ref["toolCallId"] === undefined || text(ref["toolCallId"])))) &&
    [
      "selected",
      "no_hits",
      "budget_exhausted",
      "disabled",
      "admission_denied",
      "error",
      "limited",
    ].includes(v["outcome"] as string) &&
    record(stages) &&
    keys(stages, ["exact", "prefix", "content", "compound", "candidates"]) &&
    ["exact", "prefix", "content", "compound", "candidates"].every((k) => integer(stages[k])) &&
    record(budget) &&
    keys(budget, [
      "maxItems",
      "maxTokens",
      "usedTokens",
      "usedItems",
      "maxItemTokens",
      "truncated",
    ]) &&
    ["maxItems", "maxTokens", "usedTokens", "usedItems"].every((k) => integer(budget[k])) &&
    (budget["maxItemTokens"] === undefined || integer(budget["maxItemTokens"])) &&
    typeof budget["truncated"] === "boolean" &&
    record(counts) &&
    keys(counts, ["selected", "duplicate", "budget", "item_limit"]) &&
    ["selected", "duplicate", "budget", "item_limit"].every((k) => integer(counts[k])) &&
    Array.isArray(v["selected"]) &&
    v["selected"].length <= 10 &&
    v["selected"].every(isMemoryRecallSelectedItem) &&
    counts["selected"] ===
      (v["recordType"] === "case"
        ? (v["caseSelected"] as unknown[]).length
        : v["selected"].length) &&
    Array.isArray(v["diagnostics"]) &&
    v["diagnostics"].length <= 24 &&
    v["diagnostics"].every(
      (d) =>
        record(d) &&
        keys(d, ["itemId", "reason", "match", "rank", "score"]) &&
        text(d["itemId"]) &&
        ["duplicate", "budget", "item_limit"].includes(d["reason"] as string) &&
        match(d["match"]) &&
        rankScore(d),
    ) &&
    typeof v["elapsedMs"] === "number" &&
    Number.isFinite(v["elapsedMs"]) &&
    v["elapsedMs"] >= 0 &&
    typeof v["traceTruncated"] === "boolean" &&
    integer(v["omittedDiagnosticCount"]) &&
    integer(v["omittedSourceCount"])
  );
}
function isMemoryRecallSelectedItem(v: unknown): v is MemoryRecallSelectedItem {
  if (
    !record(v) ||
    !keys(v, [
      "itemId",
      "itemVersion",
      "contentHash",
      "referenceHash",
      "range",
      "excerpt",
      "match",
      "source",
      "sourceCount",
      "sources",
      "rank",
      "score",
    ])
  )
    return false;
  const r = v["range"];
  return (
    text(v["itemId"]) &&
    integer(v["itemVersion"]) &&
    v["itemVersion"] > 0 &&
    hash(v["contentHash"]) &&
    hash(v["referenceHash"]) &&
    record(r) &&
    keys(r, ["start", "end", "total"]) &&
    integer(r["start"]) &&
    integer(r["end"]) &&
    integer(r["total"]) &&
    r["start"] <= r["end"] &&
    r["end"] <= r["total"] &&
    typeof v["excerpt"] === "boolean" &&
    match(v["match"]) &&
    [
      "user-evidence",
      "manual",
      "assistant-note",
      "execution-evidence",
      "execution-validated",
      "reviewed-reference",
    ].includes(v["source"] as string) &&
    integer(v["sourceCount"]) &&
    Array.isArray(v["sources"]) &&
    v["sources"].length <= 3 &&
    v["sources"].length <= v["sourceCount"] &&
    v["sources"].every(
      (s) =>
        record(s) &&
        keys(s, ["sessionId", "runId", "turnId", "eventId"]) &&
        ["sessionId", "runId", "turnId", "eventId"].every((k) => text(s[k])),
    ) &&
    rankScore(v)
  );
}
function isMemoryRecallCaseSelectedItem(v: unknown): v is MemoryRecallCaseSelectedItem {
  if (
    !record(v) ||
    !keys(v, [
      "candidateId",
      "contentVersion",
      "recordRevision",
      "referenceHash",
      "range",
      "excerpt",
      "sourceCount",
      "sources",
    ])
  )
    return false;
  const r = v["range"];
  return (
    text(v["candidateId"]) &&
    integer(v["contentVersion"]) &&
    v["contentVersion"] > 0 &&
    integer(v["recordRevision"]) &&
    v["recordRevision"] > 0 &&
    hash(v["referenceHash"]) &&
    record(r) &&
    keys(r, ["start", "end", "total"]) &&
    integer(r["start"]) &&
    integer(r["end"]) &&
    integer(r["total"]) &&
    r["start"] <= r["end"] &&
    r["end"] <= r["total"] &&
    typeof v["excerpt"] === "boolean" &&
    integer(v["sourceCount"]) &&
    Array.isArray(v["sources"]) &&
    v["sources"].length <= 3 &&
    v["sourceCount"] >= v["sources"].length &&
    v["sources"].every(
      (s) =>
        record(s) &&
        keys(s, ["sessionId", "runId", "turnId", "eventId"]) &&
        ["sessionId", "runId", "turnId", "eventId"].every((k) => text(s[k])),
    )
  );
}
export function isMemoryRecallRequestFacts(v: unknown): v is MemoryRecallRequestFacts {
  return (
    record(v) &&
    keys(v, ["version", "coverage", "recalls"]) &&
    (v["version"] === 1 || v["version"] === 2) &&
    new TextEncoder().encode(JSON.stringify(v)).length <= 8192 &&
    ["recorded", "unrecorded"].includes(v["coverage"] as string) &&
    Array.isArray(v["recalls"]) &&
    v["recalls"].every(
      (r) =>
        record(r) &&
        keys(r, ["recallEventId", "blockHash", "references", "caseReferences"]) &&
        (r["caseReferences"] === undefined ||
          (v["version"] === 2 &&
            Array.isArray(r["references"]) &&
            r["references"].length === 0 &&
            Array.isArray(r["caseReferences"]) &&
            r["caseReferences"].length <= 3 &&
            r["caseReferences"].every(
              (i) =>
                record(i) &&
                keys(i, ["candidateId", "contentVersion", "recordRevision", "referenceHash"]) &&
                text(i["candidateId"]) &&
                integer(i["contentVersion"]) &&
                i["contentVersion"] > 0 &&
                integer(i["recordRevision"]) &&
                i["recordRevision"] > 0 &&
                hash(i["referenceHash"]),
            ))) &&
        text(r["recallEventId"]) &&
        (r["blockHash"] === undefined || hash(r["blockHash"])) &&
        Array.isArray(r["references"]) &&
        r["references"].length <= 10 &&
        r["references"].every(
          (i) =>
            record(i) &&
            keys(i, ["itemId", "referenceHash"]) &&
            text(i["itemId"]) &&
            hash(i["referenceHash"]),
        ),
    )
  );
}
