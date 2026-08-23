export async function retainBrowserAgentLease<Lease extends { readonly leaseId: string }>(options: {
  readonly acquire: () => Promise<Lease>;
  readonly isCurrent: () => boolean | Promise<boolean>;
  readonly release: (leaseId: string) => Promise<void>;
}): Promise<Lease | null> {
  const lease = await options.acquire();
  if (await options.isCurrent()) return lease;
  await options.release(lease.leaseId);
  return null;
}

export function isBrowserPanelActive(
  selected: boolean,
  sessionStatus: "active" | "archived" | undefined,
): boolean {
  return selected && sessionStatus === "active";
}

export async function acquireBrowserViewportIfActive<Result>(
  active: boolean,
  acquire: () => Promise<Result>,
): Promise<Result | null> {
  return active ? acquire() : null;
}
