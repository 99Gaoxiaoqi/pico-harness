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
