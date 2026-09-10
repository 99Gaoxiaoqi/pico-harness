export interface CodeCellPermit {
  release(): void;
}

/** One active cell and one cancellable waiter; capacity includes physical host drain. */
export class CodeCellAdmission {
  private active = false;
  private waiter?: {
    grant(): void;
  };

  /** Undefined means the bounded queue is full. Cancellation rejects instead. */
  acquire(signal?: AbortSignal): Promise<CodeCellPermit | undefined> {
    signal?.throwIfAborted();
    if (!this.active) {
      this.active = true;
      return Promise.resolve(this.createPermit());
    }
    if (this.waiter) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (this.waiter !== waiter) return;
        this.waiter = undefined;
        signal?.removeEventListener("abort", onAbort);
        reject(signal?.reason);
      };
      const waiter = {
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve(this.createPermit());
        },
      };
      this.waiter = waiter;
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private createPermit(): CodeCellPermit {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const waiter = this.waiter;
        this.waiter = undefined;
        if (waiter) waiter.grant();
        else this.active = false;
      },
    };
  }
}

/** Default scope is this host process, shared across tools, registries and sessions. */
export const sharedCodeCellAdmission = new CodeCellAdmission();
