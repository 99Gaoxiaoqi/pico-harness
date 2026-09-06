import type { RuntimeParams, RuntimeResult } from "@pico/protocol";

type ConnectionMethod = "provider.upsert" | "provider.credential.set";
type ConnectionInvoke = <M extends ConnectionMethod>(
  method: M,
  params: RuntimeParams<M>,
) => Promise<RuntimeResult<M>>;

/** Credentials travel only through the write-only credential operation. */
export async function saveProviderConnection(
  invoke: ConnectionInvoke,
  params: RuntimeParams<"provider.upsert">,
  secret?: string,
): Promise<void> {
  if (params.provider.auth !== "none" && !secret?.trim()) throw new Error("请输入 API Key。");
  const saved = await invoke("provider.upsert", params);
  if (params.provider.auth === "none") return;
  await invoke("provider.credential.set", {
    providerId: saved.provider.id,
    secret: secret!,
    expectedRevision: saved.revision,
  });
}
