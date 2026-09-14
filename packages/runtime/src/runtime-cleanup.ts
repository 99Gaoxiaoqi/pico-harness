/** A cleanup action owned by one AgentRuntime invocation. */
export type RuntimeCleanupAction = () => void | Promise<void> | undefined;

export type RuntimeCleanupFailureHandler = (resource: string, error: unknown) => void;

interface RuntimeCleanupEntry {
  readonly resource: string;
  readonly action: RuntimeCleanupAction;
}

/**
 * Serializes the cleanup order for resources assembled by AgentRuntime.
 *
 * The scope owns no resource itself: callers register only the cleanup they
 * actually own. Disposal is idempotent and one failing action cannot prevent
 * later resources from being released.
 */
export class RuntimeCleanupScope {
  private readonly entries: RuntimeCleanupEntry[] = [];
  private disposed = false;

  constructor(private readonly onFailure: RuntimeCleanupFailureHandler) {}

  register(resource: string, action: RuntimeCleanupAction): void {
    if (this.disposed) {
      throw new Error(`Cannot register runtime cleanup after disposal: ${resource}`);
    }
    this.entries.push({ resource, action });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries) {
      try {
        await entry.action();
      } catch (error) {
        this.onFailure(entry.resource, error);
      }
    }
  }
}
