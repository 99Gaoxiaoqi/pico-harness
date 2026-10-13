export interface ExperienceManagementTarget {
  readonly itemId?: string;
  readonly candidateId?: string;
  readonly referenceItemVersion?: number;
  readonly referenceContentVersion?: number;
}

export function experienceManagementHref(
  workspacePath: string | undefined,
  target: ExperienceManagementTarget,
  tab: "pending" | "saved" | "archived" = "saved",
): string {
  const params = new URLSearchParams({ tab });
  if (workspacePath) params.set("workspace", workspacePath);
  if (target.itemId) params.set("item", target.itemId);
  if (target.candidateId) params.set("candidate", target.candidateId);
  if (target.referenceItemVersion !== undefined)
    params.set("referenceItemVersion", String(target.referenceItemVersion));
  if (target.referenceContentVersion !== undefined)
    params.set("referenceContentVersion", String(target.referenceContentVersion));
  return `/memory?${params}${target.itemId ? `#memory-${encodeURIComponent(target.itemId)}` : ""}`;
}

export function readExperienceManagementTarget(
  params: URLSearchParams,
  hash: string,
): ExperienceManagementTarget | undefined {
  let itemId = params.get("item") || undefined;
  if (!itemId && hash.startsWith("#memory-")) {
    try {
      itemId = decodeURIComponent(hash.slice("#memory-".length));
    } catch {
      return undefined;
    }
  }
  const candidateId = params.get("candidate") || undefined;
  if ((!itemId && !candidateId) || (itemId?.length ?? 0) > 512 || (candidateId?.length ?? 0) > 512)
    return undefined;
  const version = (name: string) => {
    const value = params.get(name);
    const number = value && /^\d+$/u.test(value) ? Number(value) : NaN;
    return Number.isSafeInteger(number) && number > 0 ? number : undefined;
  };
  return {
    itemId,
    candidateId,
    referenceItemVersion: version("referenceItemVersion"),
    referenceContentVersion: version("referenceContentVersion"),
  };
}
