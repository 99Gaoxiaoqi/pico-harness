/** Produced exclusively by the registry's private trusted native Bash collector. */
export interface ForegroundProcessFacts {
  readonly version: 1;
  readonly kind: "foreground_process";
  readonly exitCode: number | null;
  readonly terminationSignal: string | null;
  readonly timedOut: boolean;
  readonly outputIncomplete: boolean;
  readonly spawnFailed: boolean;
}
export function isForegroundProcessFacts(v: unknown): v is ForegroundProcessFacts {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    Object.keys(r).every((k) =>
      [
        "version",
        "kind",
        "exitCode",
        "terminationSignal",
        "timedOut",
        "outputIncomplete",
        "spawnFailed",
      ].includes(k),
    ) &&
    r["version"] === 1 &&
    r["kind"] === "foreground_process" &&
    (r["exitCode"] === null || Number.isSafeInteger(r["exitCode"])) &&
    (r["terminationSignal"] === null ||
      (typeof r["terminationSignal"] === "string" && r["terminationSignal"].length <= 64)) &&
    ["timedOut", "outputIncomplete", "spawnFailed"].every((k) => typeof r[k] === "boolean")
  );
}
