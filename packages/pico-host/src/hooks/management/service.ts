import type {
  HookEvent,
  HookHandler,
  HookSource,
  HookSnapshot,
  ResolvedHookHandler,
} from "../types.js";
import { HookTrustStore, type HookTrustFingerprint, type HookTrustStatus } from "../trust/store.js";
import { HookLocalStateStore } from "./state.js";

export interface HookManagementItem {
  id: string;
  event: HookEvent;
  type: HookHandler["type"];
  source: HookSource;
  status: HookTrustStatus | "disabled";
  matcher?: string;
  order: number;
}

export interface HookManagementReview extends HookManagementItem {
  handler: HookHandler;
  fingerprint?: HookTrustFingerprint;
}

export interface HookManagementServiceOptions {
  workDir: string;
  currentSnapshot: () => HookSnapshot;
  reload: () => Promise<boolean>;
  trustStore?: HookTrustStore;
  stateStore?: HookLocalStateStore;
}

/** `/hooks` 的无头 domain API；只接收 handler id/状态动作，不接收命令字符串。 */
export class HookManagementService {
  private readonly trustStore: HookTrustStore;
  private readonly stateStore: HookLocalStateStore;

  constructor(private readonly options: HookManagementServiceOptions) {
    this.trustStore = options.trustStore ?? new HookTrustStore();
    this.stateStore = options.stateStore ?? new HookLocalStateStore(options.workDir);
  }

  list(): readonly HookManagementItem[] {
    return allHandlers(this.options.currentSnapshot()).map(toItem);
  }

  async review(handlerId: string): Promise<HookManagementReview> {
    const entry = this.requireEntry(handlerId);
    const item = toItem(entry);
    // Plugin hooks are authenticated by the host-owned Plugin snapshot authority. Their
    // materialized path is intentionally ephemeral, so creating a HookTrustStore fingerprint
    // here would produce a misleading pending record tied to a disposable directory.
    if (entry.source.trustAuthority?.identity?.kind === "plugin") {
      return { ...item, handler: entry.handler };
    }
    if (entry.handler.type === "prompt" || entry.handler.type === "agent") {
      return { ...item, handler: entry.handler };
    }
    const fingerprint = await this.trustStore.fingerprint({
      workspace: this.options.workDir,
      source: entry.source,
      handler: entry.handler,
    });
    return { ...item, handler: entry.handler, fingerprint };
  }

  async trust(handlerId: string): Promise<void> {
    const entry = this.requireEntry(handlerId);
    if (entry.source.trustAuthority?.identity?.kind === "plugin") return;
    if (entry.handler.type === "prompt" || entry.handler.type === "agent") return;
    await this.trustStore.trustResolved(this.options.workDir, entry);
    await this.options.reload();
  }

  async enable(handlerId: string): Promise<void> {
    this.requireEntry(handlerId);
    await this.stateStore.set(handlerId, true);
    await this.options.reload();
  }

  async disable(handlerId: string): Promise<void> {
    this.requireEntry(handlerId);
    await this.stateStore.set(handlerId, false);
    await this.options.reload();
  }

  async reload(): Promise<boolean> {
    return await this.options.reload();
  }

  private requireEntry(handlerId: string): ResolvedHookHandler {
    const entry = allHandlers(this.options.currentSnapshot()).find(
      (candidate) => candidate.id === handlerId,
    );
    if (!entry) throw new Error(`Hook handler 不存在: ${handlerId}`);
    return entry;
  }
}

function allHandlers(snapshot: HookSnapshot): ResolvedHookHandler[] {
  return Object.values(snapshot.handlers).flatMap((handlers) => [...handlers]);
}

function toItem(entry: ResolvedHookHandler): HookManagementItem {
  return {
    id: entry.id,
    event: entry.event,
    type: entry.handler.type,
    source: entry.source,
    status: entry.handler.enabled === false ? "disabled" : entry.trusted ? "active" : "pending",
    ...(entry.matcher === undefined ? {} : { matcher: entry.matcher }),
    order: entry.order,
  };
}
